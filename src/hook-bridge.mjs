import { createServer, createConnection } from "node:net";
import { mkdtemp, chmod, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const HOOK_SERVER = "astra_jev_checkpoint";
const MAX_BYTES = 4 * 1024 * 1024;
export const toml = (value) => {
  if (Array.isArray(value)) return `[${value.map(toml).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value)
      .map(([k, v]) => `${JSON.stringify(k)}=${toml(v)}`)
      .join(",")}}`;
  return JSON.stringify(value);
};

export class HookBridge {
  constructor({ checkpoint, onFailure = () => {}, timeoutMs = 15000 }) {
    Object.assign(this, { checkpoint, onFailure, timeoutMs });
    this.sockets = new Set();
  }
  async open() {
    this.readyPromise = new Promise((resolve) => {
      this.markReady = resolve;
    });
    this.directory = await mkdtemp("/tmp/astra-jev-hook-");
    await chmod(this.directory, 0o700);
    this.path = join(this.directory, "ipc");
    this.server = createServer((socket) => {
      this.sockets.add(socket);
      const abort = new AbortController();
      let buffer = "",
        received = false;
      socket.setEncoding("utf8");
      const timer = setTimeout(() => {
        abort.abort();
        this.onFailure(new Error("Checkpoint timed out"));
        socket.destroy();
      }, this.timeoutMs);
      socket.on("error", () => {});
      socket.on("close", () => {
        clearTimeout(timer);
        abort.abort();
        this.sockets.delete(socket);
      });
      socket.on("data", async (chunk) => {
        if (received) return;
        buffer += chunk;
        if (Buffer.byteLength(buffer) > MAX_BYTES) {
          socket.destroy();
          return;
        }
        if (!buffer.includes("\n")) return;
        received = true;
        try {
          const message = JSON.parse(buffer.slice(0, buffer.indexOf("\n")));
          if (message.op === "ready") {
            this.ready = true;
            this.markReady(true);
          } else if (message.op === "checkpoint")
            await this.checkpoint(message.params, { signal: abort.signal });
          else throw new Error("Unknown checkpoint operation");
          if (!abort.signal.aborted)
            socket.end(JSON.stringify({ ok: true }) + "\n");
        } catch {
          if (!abort.signal.aborted)
            socket.end(JSON.stringify({ ok: false }) + "\n");
        }
      });
    });
    await new Promise((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(this.path, resolve);
    });
    await chmod(this.path, 0o600);
    return this.config();
  }
  async waitUntilReady(timeoutMs = 12000) {
    let timer;
    try {
      const ready = await Promise.race([
        this.readyPromise,
        new Promise((_, reject) => {
          timer = setTimeout(
            () =>
              reject(
                new Error(
                  "Checkpoint relay did not initialize; no adaptive turn started",
                ),
              ),
            timeoutMs,
          );
        }),
      ]);
      if (!ready) throw new Error("Checkpoint relay closed during startup");
    } finally {
      clearTimeout(timer);
    }
  }
  config() {
    const input = Object.fromEntries(
      [
        "session_id",
        "turn_id",
        "tool_use_id",
        "tool_name",
        "tool_input",
        "tool_response",
      ].map((k) => [k, "${" + k + "}"]),
    );
    const hook = {
      type: "mcp_tool",
      server: HOOK_SERVER,
      tool: "checkpoint",
      input,
      timeout: 20,
      statusMessage: "Jev: choosing Astra effort",
    };
    return [
      "features.hooks=true",
      `mcp_servers.${HOOK_SERVER}.command=${toml(process.execPath)}`,
      `mcp_servers.${HOOK_SERVER}.args=${toml([fileURLToPath(new URL("../bin/hook-mcp.mjs", import.meta.url)), this.path])}`,
      `mcp_servers.${HOOK_SERVER}.required=true`,
      `mcp_servers.${HOOK_SERVER}.startup_timeout_sec=10`,
      `mcp_servers.${HOOK_SERVER}.tool_timeout_sec=20`,
      `hooks.PostToolUse=${toml([{ matcher: ".*", hooks: [hook] }])}`,
    ];
  }
  async trustConfig(transport, cwd) {
    const list = await transport.request("hooks/list", { cwds: [cwd] });
    const hooks = list.data
      .flatMap((x) => x.hooks)
      .filter((x) => x.server === HOOK_SERVER);
    if (hooks.length !== 1)
      throw new Error("Owned checkpoint hook unavailable or conflicting");
    const h = hooks[0];
    if (
      h.source !== "sessionFlags" ||
      h.handlerType !== "mcpTool" ||
      h.eventName !== "postToolUse" ||
      h.tool !== "checkpoint" ||
      h.matcher !== ".*" ||
      h.timeoutSec !== 20 ||
      typeof h.sourcePath !== "string" ||
      !h.sourcePath ||
      !Number.isInteger(h.displayOrder) ||
      !h.enabled ||
      !h.currentHash
    )
      throw new Error("Owned checkpoint hook definition differs");
    this.trustedHook = { ...h };
    // App Server applies each dotted key as a replacement, not a recursive
    // table merge. Replace only state; replacing hooks would erase PostToolUse.
    return { "hooks.state": { [h.key]: { trusted_hash: h.currentHash } } };
  }
  ownsRun(run) {
    const h = this.trustedHook;
    return (
      !!h &&
      !!run &&
      run.source === h.source &&
      run.sourcePath === h.sourcePath &&
      Number.isInteger(h.displayOrder) &&
      run.displayOrder === h.displayOrder &&
      run.handlerType === h.handlerType &&
      run.eventName === h.eventName
    );
  }
  async close() {
    this.markReady?.(false);
    for (const socket of this.sockets) socket.destroy();
    if (this.server?.listening)
      await new Promise((resolve) => this.server.close(resolve));
    if (this.directory)
      await rm(this.directory, { recursive: true, force: true });
  }
}

export function callBridge(path, message, { timeoutMs = 17000, signal } = {}) {
  return new Promise((resolve, reject) => {
    const socket = createConnection(path);
    let buffer = "",
      done = false;
    const finish = (error, value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", cancel);
      socket.destroy();
      error ? reject(error) : resolve(value);
    };
    const cancel = () => finish(new Error("Checkpoint cancelled"));
    const timer = setTimeout(
      () => finish(new Error("Checkpoint connection timed out")),
      timeoutMs,
    );
    signal?.addEventListener("abort", cancel, { once: true });
    if (signal?.aborted) cancel();
    socket.setEncoding("utf8");
    socket.on("connect", () => socket.write(JSON.stringify(message) + "\n"));
    socket.on("data", (chunk) => {
      buffer += chunk;
      if (Buffer.byteLength(buffer) > MAX_BYTES)
        return finish(new Error("Checkpoint reply too large"));
      if (!buffer.includes("\n")) return;
      try {
        const reply = JSON.parse(buffer.slice(0, buffer.indexOf("\n")));
        reply.ok
          ? finish(null, reply)
          : finish(new Error("Checkpoint rejected"));
      } catch {
        finish(new Error("Invalid checkpoint reply"));
      }
    });
    socket.on("error", () => finish(new Error("Checkpoint connection failed")));
    socket.on("close", () => finish(new Error("Checkpoint connection closed")));
  });
}
