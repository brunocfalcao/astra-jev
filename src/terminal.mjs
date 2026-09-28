import { createInterface, clearLine, cursorTo } from "node:readline";
import { statusLines } from "./status.mjs";

// External text never controls the terminal (including split OSC/CSI sequences).
// Preserve readable escapes instead of executing cursor/clipboard/title controls.
export function terminalSafe(value) {
  return String(value ?? "").replace(
    /[\x00-\x08\x0b-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g,
    (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}

export function eventMessage(e) {
  if (e.type === "decision_selected" && e.evaluatedModel)
    return `Jev selected ${e.effort} for ${e.leaseSteps} generation${e.leaseSteps === 1 ? "" : "s"} | ${e.latencyMs} ms${e.attempts > 1 ? ` | ${e.attempts} attempts` : ""}`;
  if (e.type === "effort_captured")
    return `Astra captured ${e.effort} | generation ${e.generation}${e.lateBy ? ` | ${e.lateBy} generation(s) late` : ""}`;
  if (e.type === "effort_retained")
    return `Astra retained ${e.effort} | next ${e.leaseSteps} generation${e.leaseSteps === 1 ? "" : "s"}`;
  if (e.type === "tool_activity" && e.status === "started")
    return `Working | ${e.tool}`;
  if (e.type === "checkpoint_outside_thread")
    return "Other native threads keep their own effort settings; Jev controls this thread only.";
  if (
    [
      "evaluation_failed",
      "update_failed",
      "update_unavailable",
      "update_unconfirmed",
      "checkpoint_uncovered",
      "checkpoint_failed",
      "unsupported_capture",
    ].includes(e.type)
  )
    return `Attention | ${e.reason ?? e.type.replaceAll("_", " ")} | use /status for evidence`;
  return null;
}

export class Terminal {
  constructor({
    input = process.stdin,
    output = process.stderr,
    onCommand = async () => {},
    onInterrupt = () => {},
    safe = terminalSafe,
  } = {}) {
    Object.assign(this, { input, output, onCommand, onInterrupt, safe });
    this.color =
      !!output.isTTY && !process.env.NO_COLOR && process.env.TERM !== "dumb";
    this.questions = [];
    this.rl = createInterface({
      input,
      output,
      terminal: !!input.isTTY && !!output.isTTY,
      historySize: 100,
    });
    this.rl.on("line", (line) => this.line(line));
    this.rl.on("SIGINT", () => {
      this.cancelQuestions();
      this.onInterrupt();
    });
    this.rl.on("close", () => {
      this.closed = true;
      this.cancelQuestions();
      this.promptResolve?.(null);
      this.promptResolve = null;
    });
  }
  style(text, code = "1") {
    return this.color ? `\x1b[${code}m${text}\x1b[0m` : text;
  }
  redraw() {
    if (this.closed) return;
    const prompt =
      this.questions[0]?.prompt ?? (this.promptResolve ? "You > " : "");
    this.rl.setPrompt(this.style(prompt));
    if (prompt) this.rl.prompt(true);
  }
  message(text) {
    if (this.output.isTTY) {
      clearLine(this.output, 0);
      cursorTo(this.output, 0);
    }
    this.output.write(`\n${this.safe(text)}\n`);
    this.redraw();
  }
  header(info) {
    this.output.write(`\n${this.style("Astra + Jev")}\n`);
    this.message(
      `Thread: ${info.threadId}\nMode: ${info.mode}\nDecision log: ${info.logPath ?? "host log"}\n\n/help commands  /status evidence  Ctrl-C interrupt`,
    );
  }
  event(event) {
    const text = eventMessage(event);
    if (text) this.message(text);
  }
  status(value) {
    this.message(statusLines(value).join("\n"));
  }
  async line(line) {
    if (this.questions.length) {
      const question = this.questions.shift();
      question.resolve(line);
      this.redraw();
      return;
    }
    if (line.trim().startsWith("/")) {
      try {
        await this.onCommand(line.trim());
      } catch (error) {
        this.message(error.message);
      }
      this.redraw();
      return;
    }
    if (this.promptResolve) {
      const resolve = this.promptResolve;
      this.promptResolve = null;
      if (line.trim()) resolve(line);
      else {
        this.promptResolve = resolve;
        this.redraw();
      }
    } else if (line.trim())
      this.message(
        "Astra is working. Use /status or /interrupt; send the next prompt when this turn finishes.",
      );
  }
  prompt() {
    if (this.closed) return Promise.resolve(null);
    return new Promise((resolve) => {
      this.promptResolve = resolve;
      this.redraw();
    });
  }
  ask(prompt) {
    if (this.closed) return Promise.resolve("");
    return new Promise((resolve) => {
      this.questions.push({ prompt, resolve });
      this.redraw();
    });
  }
  cancelQuestions() {
    for (const q of this.questions.splice(0)) q.resolve("");
  }
  close() {
    this.rl.close();
  }
}
