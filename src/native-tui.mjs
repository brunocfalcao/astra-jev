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
  constructor({ session, record = () => {}, onOpen = () => {} }) {
    Object.assign(this, { session, record, onOpen });
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
      if (this.client || request.url !== "/rpc") {
        socket.destroy();
        return;
      }
      this.websocket.handleUpgrade(request, socket, head, (client) => {
        this.client = client;
        client.on("error", () => {});
        client.on("message", (data, binary) => {
          if (binary) {
            client.close(1003);
            return;
          }
          void this.receive(data).catch(() => client.close(1007));
        });
        client.on("close", () => {
          this.client = null;
          for (const resolve of this.pending.values()) resolve(undefined);
          this.pending.clear();
          if (this.session.running)
            void this.session.interrupt().catch(() => {});
        });
      });
    });
    this.forward = (message) => {
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
    this.session.onRequest = (message) => {
      if (!this.client) return undefined;
      return new Promise((resolve) => {
        const id = `astra-jev-${++this.nextRequest}`;
        this.pending.set(id, resolve);
        this.send({ ...message, id });
      });
    };
    await new Promise((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(this.path, resolve);
    });
    await chmod(this.path, 0o600);
    return `unix://${this.path}`;
  }
  send(message) {
    if (this.client?.readyState === WebSocket.OPEN)
      this.client.send(JSON.stringify(message));
  }
  async receive(data) {
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
      } else if (method === "thread/resume") {
        this.requireThread(params);
        result = await this.session.transport.request(method, {
          ...params,
          ...this.session.threadOptions,
          model: "gpt-6-astra",
          config: { ...params.config, ...this.session.hookConfig },
        });
        this.attached = true;
      } else if (
        ["thread/start", "thread/fork", "turn/steer"].includes(method)
      ) {
        throw new Error(
          method === "turn/steer"
            ? "Jev cannot safely reassess steered input on this stock API yet. Interrupt the turn, then send the follow-up."
            : "This controller owns one thread. Start another astra-jev session for a new or forked thread.",
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
      this.send({ id, result });
    } catch (error) {
      if (startingTurn) this.effortNotices.finish();
      this.send({
        id,
        error: {
          code: -32602,
          message: this.session.controller.context.clean(error.message, 500),
        },
      });
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
    noAltScreen = true,
  } = {}) {
    const args = [
      "--remote",
      `unix://${this.path}`,
      ...(noAltScreen && !codexArgs?.includes("--no-alt-screen")
        ? ["--no-alt-screen"]
        : []),
      ...defaults,
    ];
    // Remote resume rejects CLI permission overrides. The owned thread and
    // Session.startTurn enforce the launcher's native read-only policy instead.
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
      if (this.session.onEvent === this.onEvent)
        this.session.onEvent = this.previousOnEvent;
      if (this.forward)
        this.session.transport.off("notification", this.forward);
      if (this.backendEnded)
        this.session.transport.off("closed", this.backendEnded);
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
