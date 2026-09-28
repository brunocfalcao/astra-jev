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
    const gated = !this.fixedEffort;
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
    const gated = !this.fixedEffort;
    const hookConfig = this.hookConfig;
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
    this.openResult = result;
    this.selectedModel = result.model;
    if (gated) await this.bridge.waitUntilReady();
    this.threadId = result.thread.id;
    this.threadPath = result.thread.path;
    this.controller.threadId = this.threadId;
    if (resume) this.controller.context.hydrate(result.thread.turns);
    this.mode = this.fixedEffort
      ? "fixed"
      : resume
        ? "adaptive-resume"
        : "adaptive-checkpoint";
    if (resume && !this.fixedEffort)
      this.onNotice(
        "Resumed session: Jev reassesses at supported tool checkpoints. Native generation counts and live capture confirmation are unavailable on resume.",
      );
    this.record({
      time: new Date().toISOString(),
      type: "session_opened",
      threadId: this.threadId,
      mode: this.mode,
      captureAvailable: this.controller.captureEvents,
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
    const previousModel = this.selectedModel ?? "gpt-6-astra";
    const model = this.requestedModel(params);
    const astra = model === "gpt-6-astra";
    this.requireSupportedSelection(model);
    if (astra && this.checkpointFailed)
      throw new Error(
        "Native checkpoint failed; restart this session or launch with fixed effort.",
      );
    const mode = params.collaborationMode;
    this.selectModel(model);
    this.running = true;
    try {
      const input = params.input ?? [];
      for (const image of input.filter((x) => x.type === "localImage"))
        if (!(await stat(image.path)).isFile())
          throw new Error("Image attachment is not a file");
      this.text = "";
      const options = {
        ...params,
        threadId: this.threadId,
      };
      if (astra) {
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
        Object.assign(options, { model: "gpt-6-astra", effort });
        if (mode)
          options.collaborationMode = {
            ...mode,
            settings: {
              ...mode.settings,
              model: "gpt-6-astra",
              reasoning_effort: effort,
            },
          };
      } else {
        this.record({
          time: new Date().toISOString(),
          type: "turn_preparing",
          threadId: this.threadId,
        });
      }
      const result = await this.transport.request("turn/start", options);
      // A fast turn can complete in the same JSONL chunk as this response,
      // before the awaiting continuation runs. Do not revive its cleared ID.
      if (this.running) {
        if (astra) this.controller.attach(result.turn.id);
        this.turnId = result.turn.id;
      }
      return result;
    } catch (error) {
      this.running = false;
      this.controller.stop();
      if (this.selectedModel === model) this.selectModel(previousModel);
      throw error;
    }
  }
  async steerTurn(params) {
    const result = await this.transport.request("turn/steer", params);
    const acceptedTurnId = result.turnId;
    // Completion or a new turn can race this acknowledgement. Do not revive
    // an old controller or apply old input to its replacement.
    if (
      this.mode !== "inactive" &&
      this.running &&
      this.controller.active &&
      acceptedTurnId === this.turnId &&
      acceptedTurnId === this.controller.turnId
    ) {
      const input = params.input ?? [];
      this.controller.addInput({
        prompt: input
          .filter((x) => x.type === "text")
          .map((x) => x.text)
          .join("\n"),
        imageCount: input.filter((x) =>
          ["localImage", "image"].includes(x.type),
        ).length,
      });
    }
    return result;
  }
  requestedModel(params = {}) {
    // Stock Codex gives collaboration settings precedence over the top-level model.
    return (
      params.collaborationMode?.settings?.model ??
      params.model ??
      this.selectedModel ??
      "gpt-6-astra"
    );
  }
  requireSupportedSelection(model) {
    if (this.requireJev && model !== "gpt-6-astra")
      throw new Error(
        "Jev is required for this session and supports Astra only. Select Astra or restart with requireJev disabled.",
      );
  }
  async updateSettings(params) {
    this.requireSupportedSelection(this.requestedModel(params));
    return this.transport.request("thread/settings/update", params);
  }
  selectModel(model) {
    this.selectedModel = model;
    // A settings change during a turn applies to the next turn. Keep the
    // running controller attached to the model that owns the current work.
    if (this.running) return;
    const mode =
      model !== "gpt-6-astra"
        ? "inactive"
        : this.fixedEffort
          ? "fixed"
          : this.resumed
            ? "adaptive-resume"
            : "adaptive-checkpoint";
    if (this.mode === mode && this.status().model === model) return;
    this.mode = mode;
    this.controller.stop();
    this.controller.capturedEffort = null;
    this.controller.turnId = null;
    this.controller.threadId = null;
    this.controller.context.reset("");
    this.record({
      time: new Date().toISOString(),
      type: "model_changed",
      threadId: this.threadId,
      model,
      mode,
    });
  }
  async notification({ method, params: p }) {
    if (["warning", "configWarning"].includes(method)) {
      this.onNotice(p.message ?? p.summary);
      return;
    }
    if (p.threadId !== this.threadId) return;
    if (method === "thread/settings/updated" && p.threadSettings?.model)
      this.selectModel(p.threadSettings.model);
    const eventTurnId = p.turnId ?? p.turn?.id;
    const currentTurnId = this.turnId ?? this.controller?.turnId;
    if (eventTurnId && currentTurnId && eventTurnId !== currentTurnId) return;
    if (
      method === "hook/completed" &&
      this.controller?.active &&
      this.bridge?.ownsRun(p.run) &&
      ["failed", "blocked", "stopped"].includes(p.run.status)
    ) {
      await this.failCheckpoint();
      return;
    }
    if (this.controller && this.mode !== "inactive")
      await this.controller.handle(method, p);
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
      if (this.mode === "inactive")
        this.record({
          time: new Date().toISOString(),
          type: "turn_completed",
          threadId: this.threadId,
          turnId: p.turn.id,
          status: p.turn.status,
        });
      this.waiter?.resolve(p.turn);
      this.running = false;
      this.turnId = null;
      if (this.selectedModel) this.selectModel(this.selectedModel);
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
    if (this.checkpointFailed || this.closed || this.mode === "inactive")
      return;
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
    // The native relay stays attached so Astra can resume later. Other models
    // pass through without retaining their content or contacting the evaluator.
    if (this.mode === "inactive") return;
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
