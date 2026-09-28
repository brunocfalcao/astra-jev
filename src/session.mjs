import { AppServer } from "./app-server.mjs";
import { Controller } from "./controller.mjs";
import { Context } from "./context.mjs";
import { HookBridge } from "./hook-bridge.mjs";
import { Status } from "./status.mjs";
import { stat } from "node:fs/promises";
import { resolve } from "node:path";

export class Session {
  constructor({
    jev,
    secrets = [],
    record = () => {},
    onEvent = () => {},
    logPath,
    onText = () => {},
    onNotice = () => {},
    onRequest,
    transport,
    config = [],
    cwd = process.cwd(),
    fixedEffort = null,
    threadOptions = {},
    nativeUi = false,
    requireJev = false,
    resumePermissions = "read-only",
  } = {}) {
    Object.assign(this, {
      jev,
      secrets,
      record,
      onEvent,
      logPath,
      onText,
      onNotice,
      onRequest,
      cwd,
      fixedEffort,
      threadOptions,
      requireJev,
      resumePermissions,
    });
    this.statusTracker = new Status();
    this.record = (event) => {
      this.statusTracker.update(event);
      record(event);
      this.onEvent(event);
    };
    this.transport =
      transport ?? new AppServer({ cwd, config, secrets, nativeUi });
    this.text = "";
    this.transport.on("notification", (m) => {
      void this.notification(m).catch((e) => this.waiter?.reject(e));
    });
    this.transport.on("request", (m) => {
      void this.serverRequest(m).catch((e) => {
        this.onNotice(e.message);
        try {
          this.transport.reject(m.id, "Client request failed");
        } catch {}
      });
    });
    this.transport.on("failure", (e) => this.waiter?.reject(e));
    this.transport.on("diagnostic", (s) => this.onNotice(s));
  }
  async prepare({ resume } = {}) {
    this.resumed = !!resume;
    const gated = !resume && !this.fixedEffort;
    if (gated) {
      this.bridge = new HookBridge({
        checkpoint: (event, options) => this.checkpoint(event, options),
        onFailure: () => {
          void this.failCheckpoint().catch(() => {});
        },
      });
      this.transport.config.push(...(await this.bridge.open()));
    }
    const initialized = await this.transport.connect();
    this.initialized = initialized;
    if (!/^astra_jev\/0\.157\.1(?:\s|$)/.test(initialized.userAgent ?? ""))
      throw new Error(
        "Managed sessions require verified stock Codex 0.157.1; this version must be validated before integration can run.",
      );
    const hookConfig = gated
      ? await this.bridge.trustConfig(this.transport, this.cwd)
      : {};
    this.hookConfig = hookConfig;
    const catalog = await this.transport.request("model/list", {
      includeHidden: true,
    });
    this.model = catalog.data.find(
      (m) => m.model === "gpt-6-astra" || m.id === "gpt-6-astra",
    );
    if (!this.model)
      throw new Error("Astra is unavailable in this Codex account");
    const efforts = this.model.supportedReasoningEfforts.map(
      (x) => x.reasoningEffort,
    );
    if (this.fixedEffort && !efforts.includes(this.fixedEffort))
      throw new Error("Unsupported fixed Astra effort");
    if (!this.fixedEffort && !this.jev)
      throw new Error("Jev evaluator missing");
    const evaluator = {
      decide: (state, options) => {
        const effort = this.manualEffort ?? this.fixedEffort;
        return effort
          ? { effort, leaseSteps: 10, source: "manual" }
          : this.jev.decide(state, options);
      },
    };
    this.controller = new Controller({
      jev: evaluator,
      context: new Context({ secrets: this.secrets }),
      captureEvents: !resume,
      gated,
      requireJev: this.requireJev,
      onFatal: () => this.interrupt(),
      supportedEfforts: efforts,
      record: this.record,
      rpc: (m, p, options) => this.transport.request(m, p, options),
    });
    this.prepared = true;
  }
  async open({ resume, params = {} } = {}) {
    if (!this.prepared) await this.prepare({ resume });
    if (this.threadId) throw new Error("This controller already owns a thread");
    if (!!resume !== this.resumed)
      throw new Error("Thread selection does not match this launch mode");
    if (params.model && params.model !== "gpt-6-astra")
      throw new Error("This session uses Astra only");
    const gated = !resume && !this.fixedEffort;
    const hookConfig = this.hookConfig;
    if (resume && this.resumePermissions === "read-only") {
      this.threadOptions = {
        ...this.threadOptions,
        sandbox: "read-only",
        approvalPolicy: "never",
      };
    }
    const options = {
      ...params,
      model: "gpt-6-astra",
      ...this.threadOptions,
      config: { ...params.config, ...this.threadOptions.config, ...hookConfig },
    };
    const result = resume
      ? await this.transport.request("thread/resume", {
          threadId: resume,
          ...options,
        })
      : await this.transport.request("thread/start", {
          cwd: this.cwd,
          ...options,
          experimentalRawEvents: true,
        });
    if (result.model !== "gpt-6-astra")
      throw new Error("Codex did not select Astra");
    if (
      resume &&
      this.resumePermissions === "read-only" &&
      result.sandbox?.type !== "readOnly"
    )
      throw new Error(
        "Codex did not confirm the read-only resume policy; no turn was started",
      );
    this.openResult = result;
    if (gated) await this.bridge.waitUntilReady();
    this.threadId = result.thread.id;
    this.threadPath = result.thread.path;
    this.controller.threadId = this.threadId;
    if (resume) this.controller.context.hydrate(result.thread.turns);
    this.mode = resume
      ? "turn-only-resume"
      : this.fixedEffort
        ? "fixed"
        : "adaptive-checkpoint";
    if (resume)
      this.onNotice(
        "Resumed session: Jev selects effort per turn. Stock Codex 0.157.1 does not expose raw generation events on resume; live adaptation and capture verification are unavailable.",
      );
    this.record({
      time: new Date().toISOString(),
      type: "session_opened",
      threadId: this.threadId,
      mode: this.mode,
      model: "gpt-6-astra",
      policy: this.fixedEffort ?? "auto",
      sandbox: result.sandbox?.type ?? "unknown",
      requireJev: this.requireJev,
    });
    return {
      threadId: this.threadId,
      threadPath: this.threadPath,
      mode: this.mode,
      logPath: this.logPath,
      status: this.status(),
    };
  }
  status() {
    return this.statusTracker.snapshot({
      running: this.running ?? false,
      logPath: this.logPath,
      sandbox: this.openResult?.sandbox?.type ?? "unknown",
      supportedEfforts:
        this.model?.supportedReasoningEfforts.map((x) => x.reasoningEffort) ??
        [],
    });
  }
  setEffort(effort) {
    if (this.running)
      throw new Error(
        "Change effort between turns; Ctrl-C interrupts the current turn.",
      );
    if (effort === "auto" && this.fixedEffort)
      throw new Error(
        "Start a new adaptive session to enable Jev; this session was launched fixed-only.",
      );
    if (effort !== "auto" && !this.status().supportedEfforts.includes(effort))
      throw new Error("Unsupported Astra effort");
    this.manualEffort = effort === "auto" ? null : effort;
    this.record({
      time: new Date().toISOString(),
      type: "policy_changed",
      threadId: this.threadId,
      policy: effort,
    });
    return this.status();
  }
  async run(prompt, { images = [] } = {}) {
    if (this.running) throw new Error("A turn is already running");
    if (!Array.isArray(images) || images.some((x) => typeof x !== "string"))
      throw new Error("Image attachments must be local file paths");
    const paths = images.map((path) => resolve(this.cwd, path));
    let complete, fail;
    const finished = new Promise((r, j) => {
      complete = r;
      fail = j;
    });
    this.waiter = { resolve: complete, reject: fail };
    finished.catch(() => {});
    try {
      await this.startTurn({
        input: [
          { type: "text", text: prompt },
          ...paths.map((path) => ({ type: "localImage", path })),
        ],
      });
      const turn = await finished;
      if (this.controller.inFlight) await this.controller.inFlight;
      if (turn.status === "failed")
        throw new Error(turn.error?.message ?? "Astra turn failed");
      return {
        threadId: this.threadId,
        turnId: turn.id,
        status: turn.status,
        text: this.text,
        mode: this.mode,
        generations: this.controller.completedGenerations,
      };
    } finally {
      this.waiter = null;
      this.turnId = null;
      this.running = false;
    }
  }
  async startTurn(params) {
    if (this.running) throw new Error("A turn is already running");
    if (this.checkpointFailed)
      throw new Error(
        "Native checkpoint failed; restart this session or launch with fixed effort.",
      );
    if (params.model && params.model !== "gpt-6-astra")
      throw new Error("This session uses Astra only");
    const mode = params.collaborationMode;
    if (mode?.settings?.model && mode.settings.model !== "gpt-6-astra")
      throw new Error("This session uses Astra only");
    this.running = true;
    try {
      const input = params.input ?? [];
      for (const image of input.filter((x) => x.type === "localImage"))
        if (!(await stat(image.path)).isFile())
          throw new Error("Image attachment is not a file");
      const prompt = input
        .filter((x) => x.type === "text")
        .map((x) => x.text)
        .join("\n");
      const effort = await this.controller.begin({
        threadId: this.threadId,
        prompt,
        defaultEffort: this.model.defaultReasoningEffort,
        imageCount: input.filter((x) =>
          ["localImage", "image"].includes(x.type),
        ).length,
      });
      this.text = "";
      const options = {
        ...params,
        threadId: this.threadId,
        model: "gpt-6-astra",
        effort,
      };
      if (mode)
        options.collaborationMode = {
          ...mode,
          settings: {
            ...mode.settings,
            model: "gpt-6-astra",
            reasoning_effort: effort,
          },
        };
      if (this.threadOptions.sandbox === "read-only") {
        delete options.permissions;
        options.sandboxPolicy = { type: "readOnly", networkAccess: false };
        options.approvalPolicy = "never";
      }
      const result = await this.transport.request("turn/start", options);
      this.controller.attach(result.turn.id);
      this.turnId = result.turn.id;
      return result;
    } catch (error) {
      this.running = false;
      this.controller.stop();
      throw error;
    }
  }
  async notification({ method, params: p }) {
    if (["warning", "configWarning"].includes(method)) {
      this.onNotice(p.message ?? p.summary);
      return;
    }
    if (p.threadId !== this.threadId) return;
    const eventTurnId = p.turnId ?? p.turn?.id;
    if (
      eventTurnId &&
      this.controller?.turnId &&
      eventTurnId !== this.controller.turnId
    )
      return;
    if (
      method === "hook/completed" &&
      this.controller?.active &&
      this.bridge?.ownsRun(p.run) &&
      ["failed", "blocked", "stopped"].includes(p.run.status)
    ) {
      await this.failCheckpoint();
      return;
    }
    if (this.controller) await this.controller.handle(method, p);
    if (
      ["item/started", "item/completed"].includes(method) &&
      ["commandExecution", "fileChange", "mcpToolCall", "webSearch"].includes(
        p.item?.type,
      )
    )
      this.record({
        time: new Date().toISOString(),
        type: "tool_activity",
        threadId: this.threadId,
        tool: p.item.tool ?? p.item.type,
        status: method === "item/started" ? "started" : "completed",
      });
    if (method === "turn/started") this.turnId = p.turn.id;
    if (method === "item/agentMessage/delta") {
      this.text += p.delta;
      this.onText(p.delta);
    }
    if (method === "turn/completed") {
      this.waiter?.resolve(p.turn);
      this.running = false;
      this.turnId = null;
    }
  }
  async serverRequest(message) {
    if (this.onRequest) {
      const result = await this.onRequest(message, this);
      if (result !== undefined) {
        this.transport.respond(message.id, result);
        return;
      }
    }
    if (message.method.endsWith("/requestApproval")) {
      this.onNotice("Approval declined: no interactive approval handler.");
      this.transport.respond(message.id, { decision: "decline" });
      return;
    }
    this.transport.reject(
      message.id,
      "This terminal client does not support that request",
    );
  }
  async interrupt() {
    this.controller?.stop();
    if (this.turnId)
      await this.transport.request(
        "turn/interrupt",
        {
          threadId: this.threadId,
          turnId: this.turnId,
        },
        { timeoutMs: 4000 },
      );
    this.record({
      time: new Date().toISOString(),
      type: "turn_interrupted",
      threadId: this.threadId,
    });
  }
  async failCheckpoint() {
    if (this.checkpointFailed || this.closed) return;
    this.checkpointFailed = true;
    this.record({
      time: new Date().toISOString(),
      type: "checkpoint_failed",
      threadId: this.threadId,
      reason:
        "Native checkpoint failed; interrupting this turn. Restart the session before further adaptive work.",
    });
    try {
      await this.interrupt();
    } catch {
      await this.close();
    }
  }
  async checkpoint(event, options) {
    // Stock child threads inherit the parent's config, including this hook.
    // This controller owns one thread: don't alter another thread's result or
    // send its content to Jev simply because it inherited our local relay.
    if (
      this.threadId &&
      typeof event?.session_id === "string" &&
      event.session_id &&
      event.session_id !== this.threadId
    ) {
      if (!this.outsideThreadSeen) {
        this.outsideThreadSeen = true;
        this.record({
          time: new Date().toISOString(),
          type: "checkpoint_outside_thread",
          threadId: this.threadId,
        });
      }
      return;
    }
    return this.controller.checkpoint(event, options);
  }
  async close() {
    if (this.closed) return;
    this.closed = true;
    this.controller?.stop();
    await this.bridge?.close();
    await this.transport.close();
    this.record({
      time: new Date().toISOString(),
      type: "session_closed",
      threadId: this.threadId,
    });
  }
}
