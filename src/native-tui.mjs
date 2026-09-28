import { createServer } from "node:http";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { HOOK_SERVER } from "./hook-bridge.mjs";
import { EffortNotices } from "./effort-notices.mjs";

// Use the pinned pure-JS implementation; optional native addons are unnecessary.
process.env.WS_NO_BUFFER_UTIL = "1";
process.env.WS_NO_UTF_8_VALIDATE = "1";
const { WebSocketServer, WebSocket } = await import("ws");

export class NativeTui {
  constructor({
    session,
    record = () => {},
    verbose = true,
    onOpen = () => {},
    createFreshSession,
    onSessionChanged = () => {},
  }) {
    Object.assign(this, {
      session,
      record,
      verbose,
      onOpen,
      createFreshSession,
      onSessionChanged,
    });
    this.pending = new Map();
    this.nextRequest = 0;
  }
  async open() {
    this.directory = await mkdtemp("/tmp/astra-jev-tui-");
    await chmod(this.directory, 0o700);
    this.path = join(this.directory, "native.sock");
    this.server = createServer((_, response) => {
      response.writeHead(404);
      response.end();
    });
    this.websocket = new WebSocketServer({
      noServer: true,
      perMessageDeflate: false,
      maxPayload: 16 * 1024 * 1024,
    });
    this.server.on("upgrade", (request, socket, head) => {
      // The native resume picker reconnects for the selected conversation.
      // Its previous socket can still be present when the new upgrade arrives.
      const pickerHandoff =
        this.session.resumed && !this.session.threadId && !this.opening;
      if ((this.client && !pickerHandoff) || request.url !== "/rpc") {
        socket.destroy();
        return;
      }
      this.websocket.handleUpgrade(request, socket, head, (client) => {
        const previous = this.client;
        this.client = client;
        if (previous) {
          for (const resolve of this.pending.values()) resolve(undefined);
          this.pending.clear();
          previous.terminate();
        }
        client.on("error", () => {});
        client.on("message", (data, binary) => {
          if (binary) {
            client.close(1003);
            return;
          }
          void this.receive(data, client).catch(() => client.close(1007));
        });
        client.on("close", () => {
          if (this.client !== client) return;
          this.client = null;
          for (const resolve of this.pending.values()) resolve(undefined);
          this.pending.clear();
          if (this.session.running)
            void this.session.interrupt().catch(() => {});
        });
      });
    });
    this.bindSession(this.session);
    await new Promise((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(this.path, resolve);
    });
    await chmod(this.path, 0o600);
    return `unix://${this.path}`;
  }
  bindSession(session) {
    this.session = session;
    this.forward = (message) => {
      if (
        this.session.mode === "inactive" &&
        ["hook/started", "hook/completed"].includes(message.method) &&
        this.session.bridge?.ownsRun(message.params?.run)
      )
        return;
      if (
        ["rawResponseItem/completed", "rawResponse/completed"].includes(
          message.method,
        )
      )
        return;
      this.send(message);
    };
    this.session.transport.on("notification", this.forward);
    this.effortNotices = new EffortNotices({
      session: this.session,
      verbose: this.verbose,
      emit: (message, detail) => {
        if (this.client?.readyState !== WebSocket.OPEN) return;
        this.send(message);
        this.record({
          time: new Date().toISOString(),
          type: "native_tui_effort_notice",
          threadId: message.params.threadId,
          turnId: message.params.turnId,
          ...detail,
        });
      },
    });
    this.previousOnEvent = this.session.onEvent;
    this.onEvent = (event) => {
      this.previousOnEvent?.(event);
      this.effortNotices.handle(event);
    };
    this.session.onEvent = this.onEvent;
    this.backendEnded = () => {
      this.backendFailed = !this.session.closed;
      void this.close();
    };
    this.session.transport.on("closed", this.backendEnded);
    this.previousOnRequest = this.session.onRequest;
    this.onRequest = (message) => {
      if (!this.client) return undefined;
      return new Promise((resolve) => {
        const id = `astra-jev-${++this.nextRequest}`;
        this.pending.set(id, resolve);
        this.send({ ...message, id });
      });
    };
    this.session.onRequest = this.onRequest;
  }
  unbindSession() {
    if (this.session.onEvent === this.onEvent)
      this.session.onEvent = this.previousOnEvent;
    if (this.session.onRequest === this.onRequest)
      this.session.onRequest = this.previousOnRequest;
    if (this.forward) this.session.transport.off("notification", this.forward);
    if (this.backendEnded)
      this.session.transport.off("closed", this.backendEnded);
  }
  async startFreshSession(client) {
    if (!this.session.resumed || this.session.threadId)
      throw new Error(
        "Only an unselected resume picker can start a fresh session",
      );
    if (!this.createFreshSession)
      throw new Error("Start a new adaptive session with astra-jev");
    const fresh = this.createFreshSession();
    try {
      await fresh.prepare();
      if (
        this.closing ||
        (client &&
          (client !== this.client || client.readyState !== WebSocket.OPEN))
      )
        throw new Error(
          "Native client disconnected while starting a fresh session",
        );
    } catch (error) {
      await fresh.close();
      throw error;
    }
    const previous = this.session;
    this.unbindSession();
    this.bindSession(fresh);
    try {
      this.onSessionChanged(fresh);
    } finally {
      await previous.close();
    }
  }
  send(message, client = this.client) {
    if (client?.readyState === WebSocket.OPEN)
      client.send(JSON.stringify(message));
  }
  async receive(data, client = this.client) {
    if (client !== this.client) return;
    const message = JSON.parse(data.toString());
    if (!message || typeof message !== "object" || Array.isArray(message))
      throw new Error("Invalid message");
    const { id, method, params = {} } = message;
    if (!method && id !== undefined) {
      const resolve = this.pending.get(id);
      if (resolve) {
        this.pending.delete(id);
        resolve(message.error ? undefined : message.result);
      }
      return;
    }
    if (id === undefined) return; // Native initialized notification: backend already initialized.
    this.record({ type: "native_tui_request", method }); // Method names only, never parameters.
    let startingTurn = false;
    try {
      let result;
      if (method === "initialize") result = this.session.initialized;
      else if (
        !this.session.threadId &&
        ["thread/start", "thread/resume"].includes(method)
      ) {
        if (this.opening)
          throw new Error("Thread selection is already in progress");
        this.opening = true;
        try {
          if (method === "thread/start" && this.session.resumed)
            await this.startFreshSession(client);
          const info = await this.session.open({
            resume: method === "thread/resume" ? params.threadId : undefined,
            params,
          });
          result = this.session.openResult;
          this.attached = true;
          await this.onOpen(info);
        } finally {
          this.opening = false;
        }
      } else if (
        method === "thread/start" &&
        !this.attached &&
        !this.session.resumed
      ) {
        // Adopt the fresh thread opened by this same backend connection, keeping
        // its raw-event subscription and exact hook trust. There is no rollout
        // to resume before its first turn.
        result = this.session.openResult;
        this.attached = true;
      } else if (method === "hooks/list") {
        result = await this.session.transport.request(method, params);
        // hooks/list describes process config, while the already-opened thread
        // holds our exact hash in its session config. Project that actual scoped
        // trust into this thread's TUI; never trust another or changed definition.
        const states = this.session.hookConfig?.["hooks.state"] ?? {};
        result = {
          ...result,
          data: result.data.map((entry) => ({
            ...entry,
            hooks: entry.hooks.map((hook) =>
              hook.server === HOOK_SERVER &&
              hook.source === "sessionFlags" &&
              hook.enabled &&
              states[hook.key]?.trusted_hash === hook.currentHash
                ? { ...hook, trustStatus: "trusted" }
                : hook,
            ),
          })),
        };
      } else if (method === "turn/start") {
        this.requireThread(params);
        startingTurn = !this.session.running;
        result = await this.session.startTurn(params);
      } else if (method === "thread/settings/update") {
        this.requireThread(params);
        result = await this.session.updateSettings(params);
      } else if (method === "turn/steer") {
        this.requireThread(params);
        result = await this.session.steerTurn(params);
      } else if (
        this.session.mode === "inactive" &&
        method === "turn/settings/update"
      ) {
        this.requireThread(params);
        result = await this.session.transport.request(method, params);
      } else if (method === "thread/resume") {
        this.requireThread(params);
        result = await this.session.transport.request(method, {
          ...params,
          model: this.session.selectedModel ?? "gpt-6-astra",
          config: {
            ...params.config,
            ...this.session.hookConfig,
          },
        });
        this.attached = true;
      } else if (["thread/start", "thread/fork"].includes(method)) {
        throw new Error(
          "This controller owns one thread. Start another astra-jev session for a new or forked thread.",
        );
      } else if (method === "thread/unsubscribe")
        result = { status: "notSubscribed" }; // Retain the controller's raw subscription until its host exits.
      else if (method === "turn/settings/update")
        throw new Error(
          "Jev manages effort in this session. Use the text client /effort control between turns, or set fixedEffort in astra-jev.json for a new session.",
        );
      else {
        // Before resume selection, Codex needs read-only access to candidate
        // threads for its native picker and name/ID lookup.
        if (params.threadId && !(method === "thread/read" && !this.attached))
          this.requireThread(params);
        result = await this.session.transport.request(method, params);
      }
      this.send({ id, result }, client);
    } catch (error) {
      if (startingTurn) this.effortNotices.finish();
      this.send(
        {
          id,
          error: error.rpcError ?? {
            code: -32602,
            message: this.session.controller.context.clean(error.message, 500),
          },
        },
        client,
      );
    }
  }
  requireThread(params) {
    if (params.threadId !== this.session.threadId)
      throw new Error(
        "This native TUI is connected to a different owned thread",
      );
  }
  async launch({
    cwd,
    prompt,
    codexArgs,
    defaults = ["--model", "gpt-6-astra"],
  } = {}) {
    const args = ["--remote", `unix://${this.path}`, ...defaults];
    if (codexArgs) args.push(...codexArgs);
    else {
      args.push("--cd", cwd);
      if (this.session.resumed) args.push("resume", this.session.threadId);
      if (prompt) args.push(prompt);
    }
    const env = { ...process.env };
    delete env.TYPESAFE_API_KEY;
    this.child = spawn("codex", args, { env, stdio: "inherit", shell: false });
    return await new Promise((resolve, reject) => {
      this.child.once("error", reject);
      this.child.once("exit", (code, signal) =>
        resolve({ code: this.backendFailed ? 1 : code, signal }),
      );
    });
  }
  close() {
    if (this.closing) return this.closing;
    this.closing = (async () => {
      this.unbindSession();
      if (this.child && this.child.exitCode === null && !this.child.signalCode)
        this.child.kill("SIGTERM");
      this.client?.terminate();
      for (const resolve of this.pending.values()) resolve(undefined);
      this.pending.clear();
      if (this.server?.listening) {
        const closed = new Promise((resolve) => this.server.close(resolve));
        this.server.closeAllConnections();
        await closed;
      }
      this.websocket?.close();
      if (this.directory)
        await rm(this.directory, { recursive: true, force: true });
    })();
    return this.closing;
  }
}
