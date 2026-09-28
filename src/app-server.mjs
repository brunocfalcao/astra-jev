import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { EventEmitter } from "node:events";
import { redact } from "./context.mjs";
import packageInfo from "../package.json" with { type: "json" };

export class AppServer extends EventEmitter {
  constructor({
    binary = "codex",
    cwd = process.cwd(),
    config = [],
    spawnImpl = spawn,
    secrets = [],
    timeoutMs = 30000,
    nativeUi = false,
  } = {}) {
    super();
    Object.assign(this, {
      binary,
      cwd,
      config,
      spawnImpl,
      secrets,
      timeoutMs,
      nativeUi,
    });
    this.pending = new Map();
    this.nextId = 0;
    this.closed = false;
  }
  async connect() {
    const args = [
      "app-server",
      "--listen",
      "stdio://",
      "--enable",
      "step_model_switching",
      "--enable",
      "reasoning_effort_override",
      "--disable",
      "shell_snapshot",
      "--disable",
      "shell_snapshot_v2",
    ];
    for (const c of this.config) args.push("-c", c);
    const env = { ...process.env };
    delete env.TYPESAFE_API_KEY;
    this.child = this.spawnImpl(this.binary, args, {
      cwd: this.cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"],
      shell: false,
    });
    this.child.on("error", (e) =>
      this.fail(new Error(`Cannot start stock Codex (${e.code ?? "unknown"})`)),
    );
    this.child.on("exit", (code, signal) => {
      this.fail(new Error(`Codex exited (${signal ?? code})`));
      this.emit("closed");
    });
    this.child.stdin.on("error", () =>
      this.fail(new Error("Codex input closed")),
    );
    this.child.stderr.on("data", (data) => {
      const text = redact(data.toString(), this.secrets);
      if (/error|panic|handshake/i.test(text))
        this.emit("diagnostic", text.slice(0, 1500));
    });
    this.lines = createInterface({ input: this.child.stdout });
    this.lines.on("line", (line) => {
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        this.fail(new Error("Invalid Codex protocol output"));
        return;
      }
      if (message.method) {
        this.emit(
          message.id === undefined ? "notification" : "request",
          message,
        );
        return;
      }
      const p = this.pending.get(message.id);
      if (!p) return;
      clearTimeout(p.timer);
      this.pending.delete(message.id);
      message.error
        ? p.reject(
            new Error(
              redact(
                `Codex ${p.method}: ${message.error.message}`,
                this.secrets,
              ).slice(0, 500),
            ),
          )
        : p.resolve(message.result);
    });
    const result = await this.request("initialize", {
      clientInfo: {
        name: "astra_jev",
        title: "Astra + Jev",
        version: packageInfo.version,
      },
      capabilities: {
        experimentalApi: true,
        mcpServerOpenaiFormElicitation: this.nativeUi,
      },
    });
    this.send({ method: "initialized", params: {} });
    return result;
  }
  send(message) {
    if (this.closed || !this.child?.stdin.writable)
      throw new Error("Codex connection closed");
    this.child.stdin.write(JSON.stringify(message) + "\n");
  }
  request(method, params, { timeoutMs = this.timeoutMs } = {}) {
    if (this.closed)
      return Promise.reject(new Error("Codex connection closed"));
    return new Promise((resolve, reject) => {
      const id = ++this.nextId;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex ${method} timed out`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer, method });
      try {
        this.send({ id, method, params });
      } catch (e) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(e);
      }
    });
  }
  respond(id, result) {
    this.send({ id, result });
  }
  reject(id, message = "Unsupported request") {
    this.send({ id, error: { code: -32601, message } });
  }
  fail(error) {
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(error);
    }
    this.pending.clear();
    this.closed = true;
    this.emit("failure", error);
  }
  async close() {
    if (!this.child) return;
    this.child.stdin.end();
    await new Promise((resolve) => {
      if (this.child.exitCode !== null || this.child.signalCode !== null) {
        resolve();
        return;
      }
      const timer = setTimeout(() => {
        this.child.kill("SIGTERM");
        resolve();
      }, 1500);
      this.child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
    this.lines?.close();
    this.fail(new Error("Codex connection closed"));
  }
}
