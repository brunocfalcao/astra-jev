import { DEFAULT_MODEL, isManagedModel } from "./models.mjs";
import { AppServer } from "./app-server.mjs";
import { Controller } from "./controller.mjs";
import { Context } from "./context.mjs";
import { HookBridge } from "./hook-bridge.mjs";
import { Status } from "./status.mjs";
import { UsagePace } from "./usage-pace.mjs";
import { stat, realpath } from "node:fs/promises";
import { resolve } from "node:path";

const effortOrder = ["low", "medium", "high", "xhigh", "max", "ultra"];

export function applyEffortAdjustment(
  decision,
  effortAdjustment,
  supportedEfforts,
) {
  const levels = effortOrder.filter((level) =>
    supportedEfforts.includes(level),
  );
  const index = levels.indexOf(decision.effort);
  if (index < 0) throw new Error("Unsupported Jev effort");
  let adjusted = index;
  if (effortAdjustment === "conservative") adjusted = Math.max(0, index - 1);
  else if (effortAdjustment === "optimistic") {
    const max = levels.indexOf("max");
    const ultra = levels.indexOf("ultra");
    adjusted = Math.min(
      index + 1,
      max >= 0 ? max : ultra >= 0 ? ultra - 1 : levels.length - 1,
    );
  }
  if (adjusted < 0) throw new Error("No supported effort at or below Max");
  return {
    ...decision,
    jevEffort: decision.effort,
    effortAdjustment,
    effort: levels[adjusted],
  };
}

export class Session {
  constructor({
    model,
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
    effortAdjustment = "default",
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
      effortAdjustment,
      threadOptions,
      requireJev,
      nativeUi,
    });
    this.launchModel = model;
    this.statusTracker = new Status();
    this.record = (event) => {
      this.statusTracker.update(event);
      record(event);
      this.onEvent(event);
    };
    this.transport =
      transport ?? new AppServer({ cwd, config, secrets, nativeUi });
    this.usagePace = new UsagePace({
      request: (...args) => this.transport.request(...args),
    });
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
    this.initialized = await this.transport.connect();
    const hookConfig = gated
      ? await this.bridge.trustConfig(this.transport, this.cwd)
      : {};
    this.hookConfig = hookConfig;
    const catalog = await this.transport.request("model/list", {
      includeHidden: true,
    });
    this.catalog = catalog.data;
    if (!this.launchModel) {
      const configuration = await this.transport.request("config/read", {
        cwd: this.cwd,
        includeLayers: false,
      });
      const configured = configuration.config?.model;
      const preferred =
        configured ?? catalog.data.find((m) => m.isDefault)?.model;
      // Preparation precedes the native picker. Its selected model wins in open().
      this.launchModel = preferred ?? DEFAULT_MODEL;
    }
    this.model = catalog.data.find(
      (m) => m.model === this.launchModel || m.id === this.launchModel,
    );
    this.requireSupportedSelection(this.launchModel);
    if (!this.model)
      throw new Error(
        `Model ${this.launchModel} is unavailable in this Codex account`,
      );
    const efforts = this.model.supportedReasoningEfforts.map(
      (x) => x.reasoningEffort,
    );
    if (this.fixedEffort && !efforts.includes(this.fixedEffort))
      throw new Error("Unsupported fixed Astra effort");
    if (!this.fixedEffort && !this.jev)
      throw new Error("Jev evaluator missing");
    const evaluator = {
      decide: async (state, options) => {
        const effort = this.manualEffort ?? this.fixedEffort;
        if (effort) return { effort, leaseSteps: 10, source: "manual" };
        await this.usagePace.read();
        const started = performance.now();
        let decision, failure;
        try {
          decision = await this.jev.decide(state, options);
          const pace = this.usagePace.snapshot();
          const notice = this.paceNotice(pace);
          if (notice) {
            this.record({
              time: new Date().toISOString(),
              type: "pace_notice",
              threadId: this.threadId,
              message: notice,
            });
            if (!this.nativeUi) this.onNotice(notice);
          }
          const adjustment =
            pace.state === "above" ? "conservative" : this.effortAdjustment;
          this.record({
            time: new Date().toISOString(),
            type: "usage_pace",
            threadId: this.threadId,
            pace,
            configuredAdjustment: this.effortAdjustment,
            effectiveAdjustment: adjustment,
          });
          return applyEffortAdjustment(
            decision,
            adjustment,
            state.supportedEfforts,
          );
        } catch (error) {
          failure = error;
          throw error;
        } finally {
          this.record({
            time: new Date().toISOString(),
            type: "jev_evaluation",
            threadId: this.threadId,
            success: !!decision,
            attempts: decision?.attempts ?? failure?.attempts ?? null,
            elapsedMs: Math.round(performance.now() - started),
            usage: decision?.usage ?? null,
          });
        }
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
    if (isManagedModel(this.launchModel)) this.useModel(this.launchModel);
    this.prepared = true;
  }
  async open({ resume, params = {} } = {}) {
    if (!this.prepared) await this.prepare({ resume });
    if (this.threadId) throw new Error("This controller already owns a thread");
    if (!!resume !== this.resumed)
      throw new Error("Thread selection does not match this launch mode");
    const openingModel = params.model ?? this.launchModel;
    this.requireSupportedSelection(openingModel);
    if (isManagedModel(openingModel)) this.useModel(openingModel);
    const gated = !this.fixedEffort;
    const hookConfig = this.hookConfig;
    const options = {
      ...params,
      model: openingModel,
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
    if (result.model !== openingModel)
      throw new Error("Codex did not select the requested model");
    this.openResult = result;
    this.selectedModel = result.model;
    if (gated) await this.bridge.waitUntilReady();
    this.threadId = result.thread.id;
    this.threadPath = result.thread.path;
    this.controller.threadId = this.threadId;
    if (resume) this.controller.context.hydrate(result.thread.turns);
    this.mode = !isManagedModel(openingModel)
      ? "inactive"
      : this.fixedEffort
        ? "fixed"
        : resume
          ? "adaptive-resume"
          : "adaptive-checkpoint";
    if (resume && !this.fixedEffort && this.mode !== "inactive")
      this.onNotice(
        "Resumed session: Jev reassesses at supported tool checkpoints. Native generation counts and live capture confirmation are unavailable on resume.",
      );
    this.record({
      time: new Date().toISOString(),
      type: "session_opened",
      projectCwd: await realpath(this.cwd),
      threadId: this.threadId,
      mode: this.mode,
      captureAvailable: this.controller.captureEvents,
      model: openingModel,
      policy: this.fixedEffort ?? "auto",
      sandbox: result.sandbox?.type ?? "unknown",
      requireJev: this.requireJev,
    });
    if (!this.nativeUi) {
      const notice = await this.paceLaunchNotice();
      if (notice) this.onNotice(notice);
    }
    return {
      threadId: this.threadId,
      threadPath: this.threadPath,
      mode: this.mode,
      logPath: this.logPath,
      status: this.status(),
    };
  }
  async paceLaunchNotice() {
    if (this.paceLaunchChecked) return null;
    this.paceLaunchChecked = true;
    if (this.fixedEffort || this.manualEffort || this.mode === "inactive")
      return null;
    const pace = await this.usagePace.read();
    return this.paceNotice(pace);
  }
  paceNotice(pace) {
    if (this.paceNoticeShown || pace.state !== "above") return null;
    this.paceNoticeShown = true;
    return "Astra-Jev — Your consumption is above pace. Using conservative effort adjustment.";
  }
  status() {
    return this.statusTracker.snapshot({
      running: this.running ?? false,
      jevPaused: !!this.jevPaused,
      enablePending: !!this.enablePending,
      manualEffort: this.manualEffort ?? null,
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
    if (effort !== "auto" && this.requireJev)
      throw new Error(
        "Jev is required; restart with requireJev disabled to select manual settings.",
      );
    if (effort === "auto") return this.enableJev();
    this.pauseJev("effort", effort);
    this.manualEffort = effort;
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
    if (this.settingsUpdate) await this.settingsUpdate.catch(() => {});
    if (this.running) throw new Error("A turn is already running");
    const previousModel = this.selectedModel ?? "gpt-6-astra";
    const model = this.requestedModel(params);
    const astra = isManagedModel(model);
    this.requireSupportedSelection(model);
    const manualModelChange = model !== previousModel;
    if (manualModelChange && this.requireJev)
      throw new Error(
        "Jev is required; restart with requireJev disabled to select manual settings.",
      );
    if (astra && this.checkpointFailed)
      throw new Error(
        "Native checkpoint failed; restart this session or launch with fixed effort.",
      );
    if (astra) this.useModel(model);
    const mode = params.collaborationMode;
    if (manualModelChange) this.pendingModel = model;
    this.running = true;
    try {
      const input = params.input ?? [];
      this.activeInput = input;
      this.controller.captureEvents = !this.resumed;
      this.statusTracker.value.captureAvailable = !this.resumed;
      for (const image of input.filter((x) => x.type === "localImage"))
        if (!(await stat(image.path)).isFile())
          throw new Error("Image attachment is not a file");
      this.text = "";
      const options = {
        ...params,
        threadId: this.threadId,
      };
      if (astra && !this.jevPaused && !manualModelChange) {
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
        Object.assign(options, { model, effort });
        if (mode)
          options.collaborationMode = {
            ...mode,
            settings: {
              ...mode.settings,
              model,
              reasoning_effort: effort,
            },
          };
      } else {
        const forcedEffort = this.manualEffort ?? this.fixedEffort;
        if (astra && forcedEffort) {
          options.effort = forcedEffort;
          if (mode)
            options.collaborationMode = {
              ...mode,
              settings: { ...mode.settings, reasoning_effort: forcedEffort },
            };
        }
        this.record({
          time: new Date().toISOString(),
          type: "turn_preparing",
          threadId: this.threadId,
        });
      }
      const result = await this.transport.request("turn/start", options);
      if (manualModelChange) {
        this.pauseJev("model");
        this.selectModel(model);
        this.pendingModel = null;
      }
      // A fast turn can complete in the same JSONL chunk as this response,
      // before the awaiting continuation runs. Do not revive its cleared ID.
      if (this.running) {
        if (astra && !this.jevPaused) this.controller.attach(result.turn.id);
        this.turnId = result.turn.id;
      }
      return result;
    } catch (error) {
      this.pendingModel = null;
      this.running = false;
      this.controller.stop();
      if (this.selectedModel === model) this.selectModel(previousModel);
      throw error;
    }
  }
  async steerTurn(params) {
    const result = await this.transport.request("turn/steer", params);
    if (this.running && result.turnId === this.turnId)
      this.activeInput = [...(this.activeInput ?? []), ...(params.input ?? [])];
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
    if (this.requireJev && !isManagedModel(model))
      throw new Error(
        "Jev is required for this session and supports Astra and GPT 6.1 Sol. Select a supported model or restart with requireJev disabled.",
      );
  }
  pauseJev(reason, effort = null) {
    if (this.fixedEffort || this.jevPaused) return;
    this.jevPaused = true;
    this.enablePending = false;
    this.controller.stop();
    this.controller.revision++;
    this.controller.pending = null;
    this.record({
      type: "policy_changed",
      threadId: this.threadId,
      policy: "manual",
      manualEffort: effort,
    });
    const message = `Astra-Jev disabled due to a manual ${reason} change. To activate it again, type $astra-jev enable in this chat.`;
    this.record({
      type: "jev_policy_notice",
      threadId: this.threadId,
      message,
    });
    if (!this.nativeUi) this.onNotice(message);
  }
  enableJev() {
    if (this.fixedEffort)
      throw new Error("Restart without fixed effort to enable Jev.");
    if (!isManagedModel(this.selectedModel))
      throw new Error(
        "Select Astra or GPT 6.1 Sol first, then run $astra-jev enable.",
      );
    if (this.running) this.enablePending = true;
    else {
      this.jevPaused = false;
      this.manualEffort = null;
      this.enablePending = false;
      this.record({
        type: "policy_changed",
        threadId: this.threadId,
        policy: "auto",
        manualEffort: null,
      });
    }
    return this.status();
  }
  updateSettings(params, method = "thread/settings/update") {
    const update = (this.settingsUpdate ?? Promise.resolve())
      .catch(() => {})
      .then(() => this.applyManualSettings(params, method));
    this.settingsUpdate = update;
    return update;
  }
  async applyManualSettings(params, method) {
    this.requireSupportedSelection(this.requestedModel(params));
    const effort =
      params.collaborationMode?.settings?.reasoning_effort ?? params.effort;
    const changed = this.requestedModel(params) !== this.selectedModel;
    const manualEffort =
      effort != null && effort !== this.controller.requestedEffort;
    if (!changed && !manualEffort)
      return this.transport.request(method, params);
    if (this.requireJev)
      throw new Error(
        "Jev is required; restart with requireJev disabled to select manual settings.",
      );
    if (this.fixedEffort) return this.transport.request(method, params);
    this.manualSettingPending = true;
    this.controller.suspend();
    try {
      // A sent native update can still arrive after cancellation. Serialize the
      // user's setting behind that acknowledgement, but never behind a slow Jev
      // evaluation that has not begun publication.
      await this.controller.publication?.catch(() => {});
      const result = await this.transport.request(method, params);
      if (method === "turn/settings/update" && result.status !== "applied")
        throw new Error(
          "Manual settings were not applied; Astra-Jev remains active.",
        );
      this.pauseJev(changed ? "model" : "effort", manualEffort ? effort : null);
      if (manualEffort) this.manualEffort = effort;
      this.selectModel(this.requestedModel(params));
      return result;
    } finally {
      this.manualSettingPending = false;
    }
  }
  useModel(model) {
    const entry = this.catalog.find((m) => (m.model ?? m.id) === model);
    if (!isManagedModel(model) || !entry)
      throw new Error(`Unavailable managed model: ${model}`);
    this.model = entry;
    if (this.controller) {
      this.controller.supportedEfforts = entry.supportedReasoningEfforts.map(
        (x) => x.reasoningEffort,
      );
      this.controller.context.model = model;
    }
  }
  selectModel(model) {
    this.selectedModel = model;
    // A settings change during a turn applies to the next turn. Keep the
    // running controller attached to the model that owns the current work.
    if (this.running) return;
    if (isManagedModel(model)) this.useModel(model);
    const mode = !isManagedModel(model)
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
    if (method === "account/rateLimits/updated") {
      this.usagePace.update(p);
      return;
    }
    if (method === "account/updated") {
      this.usagePace.clear();
      return;
    }
    if (["warning", "configWarning"].includes(method)) {
      this.onNotice(p.message ?? p.summary);
      return;
    }
    if (p.threadId !== this.threadId) return;
    if (
      method === "thread/settings/updated" &&
      p.threadSettings?.model &&
      !this.manualSettingPending
    )
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
    if (
      this.controller &&
      !this.jevPaused &&
      !this.pendingModel &&
      this.mode !== "inactive"
    )
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
      if (this.jevPaused || this.mode === "inactive")
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
      this.activeInput = null;
      if (this.selectedModel) this.selectModel(this.selectedModel);
      if (this.enablePending) this.enableJev();
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
    if (
      this.jevPaused ||
      this.checkpointFailed ||
      this.closed ||
      this.mode === "inactive"
    )
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
    if (this.jevPaused || this.manualSettingPending || this.pendingModel)
      return;
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
    try {
      return await this.controller.checkpoint(event, options);
    } catch (error) {
      if (
        (!this.jevPaused && !this.manualSettingPending) ||
        options?.signal?.aborted
      )
        throw error;
    }
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
