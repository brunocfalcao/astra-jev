import { createServer, createConnection } from "node:net";
import { mkdir, lstat, chmod } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";

export async function sessionSocket(
  name,
  directory = join(homedir(), ".local/share/astra-jev/run"),
) {
  if (!/^[a-zA-Z0-9_-]{1,40}$/.test(name))
    throw new Error(
      "Session name must contain 1–40 letters, digits, underscores or hyphens",
    );
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const info = await lstat(directory);
  if (!info.isDirectory() || info.uid !== process.getuid() || info.mode & 0o077)
    throw new Error("Session directory must be private and owned by this user");
  const path = join(
    directory,
    createHash("sha256").update(name).digest("hex").slice(0, 20) + ".sock",
  );
  if (Buffer.byteLength(path) > 103)
    throw new Error("Session socket path is too long");
  return path;
}

function wire(socket, receive) {
  let buffer = "";
  socket.setEncoding("utf8");
  socket.on("error", () => {});
  socket.on("data", (chunk) => {
    buffer += chunk;
    if (Buffer.byteLength(buffer) > 1024 * 1024) {
      socket.destroy();
      return;
    }
    let newline;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        socket.destroy();
        return;
      }
      if (!message || typeof message !== "object" || Array.isArray(message)) {
        socket.destroy();
        return;
      }
      void Promise.resolve(receive(message)).catch(() => socket.destroy());
    }
  });
  return (message) => {
    if (!socket.destroyed && socket.writable)
      socket.write(JSON.stringify(message) + "\n");
  };
}

export class SessionHost {
  constructor({ session, info, path, observerOnly = false }) {
    Object.assign(this, { session, info, path, observerOnly });
    this.peers = new Set();
    this.requests = new Map();
    this.nextRequest = 0;
    this.done = new Promise((resolve) => {
      this.finish = resolve;
    });
    session.onText = (text) => this.owner?.send({ event: "text", text });
    const notice = session.onNotice;
    session.onNotice = (text) => {
      notice(text);
      this.owner?.send({ event: "notice", text });
    };
    const onEvent = session.onEvent;
    session.onEvent = (event) => {
      onEvent?.(event);
      this.owner?.send({ event: "decision", data: event });
    };
    session.onRequest = (message) => {
      if (!this.owner) return undefined;
      return new Promise((resolve) => {
        const id = ++this.nextRequest;
        this.requests.set(id, resolve);
        this.owner.send({ event: "approval", id, message });
      });
    };
    this.backendEnded = () => {
      void this.close();
    };
    session.transport.on("closed", this.backendEnded);
  }
  replaceSession(session) {
    if (!this.observerOnly || this.session.threadId || this.session.running)
      throw new Error(
        "Only a native TUI observer can replace an unselected session",
      );
    this.session.transport.off("closed", this.backendEnded);
    this.session = session;
    session.transport.on("closed", this.backendEnded);
  }
  async listen() {
    this.server = createServer((socket) => {
      const peer = { socket };
      this.peers.add(peer);
      peer.send = wire(socket, async (message) => {
        const { id, method, params = {} } = message;
        if (id === undefined || typeof method !== "string") {
          socket.destroy();
          return;
        }
        try {
          let result;
          if (method === "attach") {
            if (this.observerOnly)
              throw new Error(
                "Native TUI controls this session; use --status to inspect it",
              );
            if (this.owner && this.owner !== peer)
              throw new Error("Session already has an attached client");
            this.owner = peer;
            result = {
              ...this.info,
              running: this.session.running ?? false,
              status: this.session.status?.(),
            };
          } else if (method === "status") {
            result = { ...this.session.status?.(), live: true };
          } else if (method === "stop") {
            peer.send({ id, result: { stopped: true } });
            setImmediate(() => {
              void this.close();
            });
            return;
          } else {
            if (peer !== this.owner)
              throw new Error("Attach before controlling this session");
            if (method === "run") {
              if (typeof params.prompt !== "string" || !params.prompt.trim())
                throw new Error("Prompt is required");
              result = await this.session.run(params.prompt, {
                images: params.images,
              });
            } else if (method === "effort") {
              result = this.session.setEffort(params.effort);
            } else if (method === "interrupt") {
              await this.session.interrupt();
              result = {};
            } else if (method === "approval") {
              const resolve = this.requests.get(params.id);
              if (!resolve) throw new Error("Approval is no longer pending");
              this.requests.delete(params.id);
              resolve(params.result ?? undefined);
              result = {};
            } else throw new Error("Unknown session operation");
          }
          peer.send({ id, result });
        } catch (error) {
          peer.send({ id, error: error.message });
        }
      });
      socket.on("close", () => {
        this.peers.delete(peer);
        if (this.owner !== peer) return;
        this.owner = null;
        this.declinePending();
        if (this.session.running) void this.session.interrupt().catch(() => {});
      });
    });
    // Never replace an existing socket: a live host or stale socket needs an
    // explicit stop/cleanup, not an implicit takeover of another session.
    await new Promise((resolve, reject) => {
      this.server.once("error", () =>
        reject(new Error("Session socket is already in use or unavailable")),
      );
      this.server.listen(this.path, resolve);
    });
    await chmod(this.path, 0o600);
  }
  declinePending() {
    for (const resolve of this.requests.values()) resolve(undefined);
    this.requests.clear();
  }
  close() {
    if (this.closing) return this.closing;
    this.closing = (async () => {
      this.declinePending();
      try {
        if (this.session.running) await this.session.interrupt();
      } catch {}
      for (const peer of this.peers) peer.socket.destroy();
      if (this.server?.listening)
        await new Promise((resolve) => this.server.close(resolve));
      await this.session.close();
      // node:net removes its own bound Unix socket on close.
      this.finish();
    })();
    return this.closing;
  }
}

export class SessionClient extends EventEmitter {
  constructor({
    path,
    onText = () => {},
    onNotice = () => {},
    onEvent = () => {},
    onRequest,
  } = {}) {
    super();
    Object.assign(this, { path, onText, onNotice, onRequest, onEvent });
    this.pending = new Map();
    this.nextId = 0;
    this.transport = this;
  }
  async connect() {
    this.socket = createConnection(this.path);
    this.send = wire(this.socket, async (m) => {
      if (m.event === "text") this.onText(m.text);
      else if (m.event === "notice") this.onNotice(m.text);
      else if (m.event === "decision") this.onEvent(m.data);
      else if (m.event === "approval") {
        let result;
        try {
          result = await this.onRequest?.(m.message);
        } catch {}
        void this.request("approval", {
          id: m.id,
          result: result ?? null,
        }).catch(() => {});
      } else {
        const p = this.pending.get(m.id);
        if (!p) return;
        this.pending.delete(m.id);
        clearTimeout(p.timer);
        m.error ? p.reject(new Error(m.error)) : p.resolve(m.result);
      }
    });
    this.socket.on("close", () => {
      for (const p of this.pending.values()) {
        clearTimeout(p.timer);
        p.reject(new Error("Local session disconnected"));
      }
      this.pending.clear();
      this.emit("closed");
    });
    await new Promise((resolve, reject) => {
      this.socket.once("connect", resolve);
      this.socket.once("error", () =>
        reject(new Error("Local session is not running")),
      );
    });
  }
  async open() {
    await this.connect();
    this.info = await this.request("attach");
    return this.info;
  }
  request(method, params = {}) {
    if (!this.socket || this.socket.destroyed)
      return Promise.reject(new Error("Local session disconnected"));
    return new Promise((resolve, reject) => {
      const id = ++this.nextId;
      const timer =
        method === "run"
          ? null
          : setTimeout(() => {
              this.pending.delete(id);
              reject(new Error("Local session request timed out"));
            }, 10000);
      this.pending.set(id, { resolve, reject, timer });
      this.send({ id, method, params });
    });
  }
  async run(prompt, { images = [] } = {}) {
    if (this.running) throw new Error("A turn is already running");
    this.running = true;
    try {
      return await this.request("run", { prompt, images });
    } finally {
      this.running = false;
    }
  }
  interrupt() {
    return this.request("interrupt");
  }
  status() {
    return this.request("status");
  }
  setEffort(effort) {
    return this.request("effort", { effort });
  }
  async close() {
    if (!this.socket || this.socket.destroyed) return;
    await new Promise((resolve) => {
      this.socket.once("close", resolve);
      this.socket.end();
    });
  }
}
