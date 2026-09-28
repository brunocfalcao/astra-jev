import { readdir, lstat, open } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";

// Metadata only. A published choice must never become a captured effort here.
export class Status {
  constructor() {
    this.value = {
      phase: "starting",
      mode: "unknown",
      policy: "auto",
      capturedEffort: null,
      selectedEffort: null,
      generations: 0,
      checkpoints: 0,
      evaluations: 0,
      jev: "not checked",
      lastError: null,
      inputTokens: 0,
      outputTokens: 0,
      cachedInputTokens: 0,
    };
  }
  update(event) {
    const v = this.value;
    if (event.threadId) v.threadId = event.threadId;
    if (event.time) v.updatedAt = event.time;
    if (event.type === "session_opened")
      Object.assign(v, {
        mode: event.mode,
        policy: event.policy ?? "auto",
        phase: "ready",
        sandbox: event.sandbox,
        requireJev: event.requireJev ?? false,
      });
    if (event.type === "policy_changed") v.policy = event.policy;
    if (event.type === "turn_preparing")
      Object.assign(v, {
        generations: 0,
        lastError: null,
        phase: "evaluating",
      });
    if (event.type === "evaluation_requested") {
      v.phase = v.policy === "auto" ? "evaluating" : "running";
      v.contextStats = event.contextStats;
    }
    if (event.type === "decision_selected") {
      v.selectedEffort = event.effort;
      v.leaseSteps = event.leaseSteps;
      v.targetGeneration = event.targetGeneration;
      if (event.evaluatedModel) {
        v.jev = "responding";
        v.evaluations++;
        v.jevLatencyMs = event.latencyMs;
        v.jevModel = event.evaluatedModel;
        v.jevAttempts = event.attempts ?? 1;
        v.policyVersion = event.policyVersion;
        v.decisionConfidence = event.confidence;
        v.leaseLimitedByUncertainty = event.leaseLimitedByUncertainty;
        v.lastError = null;
      }
      v.phase = "running";
    }
    if (event.type === "update_published") v.phase = "waiting for capture";
    if (event.type === "effort_captured") {
      v.capturedEffort = event.effort;
      v.captureGeneration = event.generation;
      v.lateBy = event.lateBy;
      v.phase = "running";
    }
    if (event.type === "generation_completed") {
      v.generations = event.generation;
      v.inputTokens += event.usage?.inputTokens ?? 0;
      v.outputTokens += event.usage?.outputTokens ?? 0;
      v.cachedInputTokens += event.usage?.cachedInputTokens ?? 0;
    }
    if (event.type === "checkpoint_released") v.checkpoints++;
    if (event.type === "checkpoint_outside_thread") v.outsideThreadSeen = true;
    if (event.type === "tool_activity") {
      v.tool = event.tool;
      v.phase = event.status === "started" ? "using tool" : "running";
    }
    if (event.type === "evaluation_failed") {
      v.jev = "degraded";
      v.lastError = event.reason;
      v.phase = "running";
    }
    if (
      [
        "update_failed",
        "update_unavailable",
        "update_unconfirmed",
        "checkpoint_uncovered",
        "checkpoint_failed",
        "unsupported_capture",
      ].includes(event.type)
    )
      v.lastError = event.reason ?? event.type.replaceAll("_", " ");
    if (event.type === "turn_completed") v.phase = event.status;
    if (event.type === "turn_interrupted") v.phase = "interrupted";
    if (event.type === "session_closed") v.phase = "closed";
    return this.snapshot();
  }
  snapshot(extra = {}) {
    return { ...this.value, ...extra };
  }
}

export function statusLines(s) {
  const effort =
    s.mode === "turn-only-resume"
      ? "unverified on resumed thread"
      : (s.capturedEffort ?? "awaiting native capture");
  return [
    `Astra + Jev | ${s.phase} | ${s.live === true ? "live host" : s.live === false ? "recorded, not a liveness check" : "current session"}`,
    modeLabel(s),
    `Astra captured: ${effort} | Selected: ${s.selectedEffort ?? "none"} | Policy: ${s.policy}`,
    `Jev: ${s.policy !== "auto" ? "paused by manual effort" : s.jev}${s.jevLatencyMs !== undefined ? ` | Last decision: ${s.jevLatencyMs} ms` : ""}`,
    ...(s.policyVersion
      ? [
          `Jev policy: ${s.policyVersion} | Confidence: ${s.decisionConfidence ?? "unavailable"} | Lease: ${s.leaseSteps} generation(s)${s.leaseLimitedByUncertainty ? " (shortened for uncertainty)" : ""}`,
        ]
      : []),
    `This turn: ${s.generations} generations | Session: ${s.checkpoints} checkpoints, ${s.evaluations} Jev decisions`,
    `Model tokens: ${s.inputTokens} input (${s.cachedInputTokens} cached), ${s.outputTokens} output`,
    `Coverage: ${s.mode === "adaptive-checkpoint" ? "supported local tools; hosted/no-tool continuations excluded" : s.mode}`,
    ...(s.sandbox ? [`Native sandbox: ${s.sandbox}`] : []),
    ...(s.outsideThreadSeen
      ? [
          "Other native threads: their own settings retained; Jev controls this thread only",
        ]
      : []),
    ...(s.lastError ? [`Attention: ${s.lastError}`] : []),
    ...(s.threadId ? [`Thread: ${s.threadId}`] : []),
    ...(s.logPath ? [`Decision log: ${s.logPath}`] : []),
    ...(s.updatedAt ? [`Updated: ${s.updatedAt}`] : []),
  ];
}

export function modeLabel(s) {
  const mode =
    s.policy && s.policy !== "auto"
      ? "FIXED"
      : s.mode === "adaptive-checkpoint"
        ? "ADAPTIVE"
        : s.mode === "turn-only-resume"
          ? "PER-TURN (capture unavailable)"
          : "INACTIVE";
  return `Jev mode: ${mode} | Permissions: ${s.sandbox ?? "not selected"} | Require Jev: ${s.requireJev ? "on" : "off"}`;
}

export async function latestStatus(
  directory = join(homedir(), ".local/share/astra-jev/logs"),
) {
  const dir = await lstat(directory);
  if (!dir.isDirectory() || dir.uid !== process.getuid() || dir.mode & 0o077)
    throw new Error(
      "Decision log directory must be private and owned by this user",
    );
  const names = (await readdir(directory))
    .filter((x) => /^\d{4}-.*\.jsonl$/.test(x))
    .sort()
    .reverse();
  for (const name of names) {
    const path = join(directory, name),
      info = await lstat(path);
    if (
      !info.isFile() ||
      info.uid !== process.getuid() ||
      info.mode & 0o077 ||
      !info.size
    )
      continue;
    const file = await open(path, "r");
    try {
      // Bound local inspection; summaries of very long logs show the last 1 MiB.
      const offset = Math.max(0, info.size - 1024 * 1024);
      const buffer = Buffer.alloc(Math.min(info.size, 1024 * 1024));
      const { bytesRead } = await file.read(buffer, 0, buffer.length, offset);
      const lines = buffer.subarray(0, bytesRead).toString("utf8").split("\n");
      if (offset) lines.shift();
      const status = new Status();
      let count = 0;
      for (const line of lines) {
        try {
          const event = JSON.parse(line);
          if (event && typeof event.type === "string") {
            status.update(event);
            count++;
          }
        } catch {}
      }
      if (count)
        return status.snapshot({
          live: false,
          logPath: path,
          ...(offset
            ? {
                lastError:
                  "Showing recent log records; session totals may be partial.",
              }
            : {}),
        });
    } finally {
      await file.close();
    }
  }
  throw new Error("No recorded Astra + Jev session yet");
}
