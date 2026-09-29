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
      jevRequests: 0,
      jevAttemptsTotal: 0,
      jevRetries: 0,
      jevFailures: 0,
      jevElapsedMs: 0,
      jevInputTokens: 0,
      jevOutputTokens: 0,
      jevUnknownUsage: 0,
      jevUnknownAttempts: 0,
      jevAccounting: false,
      jev: "not checked",
      lastError: null,
      inputTokens: 0,
      outputTokens: 0,
      cachedInputTokens: 0,
    };
  }
  update(event) {
    const v = this.value;
    if (event.type === "usage_pace") {
      v.usagePace = event.pace;
      v.configuredAdjustment = event.configuredAdjustment;
      v.effectiveAdjustment = event.effectiveAdjustment;
    }
    if (event.threadId) v.threadId = event.threadId;
    if (event.time) v.updatedAt = event.time;
    if (event.type === "session_opened")
      Object.assign(v, {
        mode: event.mode,
        captureAvailable: event.captureAvailable,
        model: event.model,
        policy: event.policy ?? "auto",
        phase: "ready",
        sandbox: event.sandbox,
        requireJev: event.requireJev ?? false,
      });
    if (event.type === "model_changed")
      Object.assign(v, {
        mode: event.mode,
        model: event.model,
        capturedEffort: null,
        selectedEffort: null,
        generations: 0,
        phase: "ready",
        jev: event.mode === "inactive" ? "inactive" : "not checked",
        lastError: null,
      });
    if (event.type === "midturn_astra_joined")
      Object.assign(v, {
        captureAvailable: false,
        selectedEffort: event.effort,
        phase: "running",
        jev: event.jev,
      });
    if (event.type === "policy_changed") {
      v.policy = event.policy;
      v.manualEffort = event.manualEffort ?? null;
    }
    if (event.type === "turn_preparing")
      Object.assign(v, {
        generations: 0,
        lastError: null,
        phase: v.mode === "inactive" ? "running" : "evaluating",
      });
    if (event.type === "evaluation_requested") {
      v.phase = v.policy === "auto" ? "evaluating" : "running";
      v.contextStats = event.contextStats;
    }
    if (event.type === "jev_evaluation") {
      v.jevAccounting = true;
      v.jevRequests++;
      v.jevFailures += event.success ? 0 : 1;
      v.jevElapsedMs += event.elapsedMs ?? 0;
      if (Number.isSafeInteger(event.attempts) && event.attempts >= 0) {
        v.jevAttemptsTotal += event.attempts;
        v.jevRetries += Math.max(0, event.attempts - 1);
      } else v.jevUnknownAttempts++;
      const usage = event.usage;
      if (
        [usage?.input_tokens, usage?.output_tokens].every(
          (x) => Number.isSafeInteger(x) && x >= 0,
        )
      ) {
        v.jevInputTokens += usage.input_tokens;
        v.jevOutputTokens += usage.output_tokens;
      } else if (event.attempts !== 0) v.jevUnknownUsage++;
      // Failed/retried attempts may be billable without returned usage.
      v.jevUnknownUsage += Math.max(0, (event.attempts ?? 1) - 1);
    }
    if (event.type === "decision_selected") {
      v.selectedEffort = event.effort;
      v.leaseSteps = event.leaseSteps;
      v.leaseApplied = event.leaseApplied;
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
    if (event.type === "update_published") {
      v.phase =
        v.captureAvailable === false ? "running" : "waiting for capture";
    }
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
  const paused = s.jevPaused || s.policy === "manual";
  const captureUnavailable =
    s.captureAvailable === false ||
    ["adaptive-resume", "turn-only-resume"].includes(s.mode);
  const lease =
    s.leaseApplied === false
      ? "Reassess at each supported checkpoint; generation lease unused"
      : `Lease: ${s.leaseSteps} generation(s)${s.leaseLimitedByUncertainty ? " (shortened for uncertainty)" : ""}`;
  const effort =
    s.mode === "inactive"
      ? "inactive for selected model"
      : paused
        ? (s.manualEffort ?? "manual selection")
        : captureUnavailable
          ? "unverified for this turn"
          : (s.capturedEffort ?? "awaiting native capture");
  return [
    `Astra + Jev | ${s.phase} | ${s.live === true ? "live host" : s.live === false ? "recorded, not a liveness check" : "current session"}`,
    modeLabel(s),
    `${paused ? "Manual effort" : "Captured effort"}: ${effort} | Jev selected: ${s.selectedEffort ?? "none"} | Policy: ${s.policy}`,
    `Jev: ${s.mode === "inactive" ? "inactive" : paused ? `paused; run $astra-jev enable${s.enablePending ? " next turn" : ""}` : s.policy !== "auto" ? "inactive for fixed effort" : s.jev}${s.jevLatencyMs !== undefined ? ` | Last decision: ${s.jevLatencyMs} ms` : ""}`,
    ...(s.model ? [`Selected model: ${s.model}`] : []),
    ...(s.usagePace
      ? [
          `Allowance pace at last decision: ${s.usagePace.state} | Adjustment: ${s.effectiveAdjustment} (configured: ${s.configuredAdjustment})`,
        ]
      : []),
    ...(s.policyVersion
      ? [
          `Jev policy: ${s.policyVersion} | Confidence: ${s.decisionConfidence ?? "unavailable"} | ${lease}`,
        ]
      : []),
    `This turn: ${captureUnavailable ? "generation count unavailable" : `${s.generations} generations`} | Session: ${s.checkpoints} checkpoints, ${s.evaluations} Jev decisions`,
    captureUnavailable
      ? "Native capture and token counts unavailable for this turn"
      : `Captured Astra tokens: ${s.inputTokens} input (${s.cachedInputTokens} cached), ${s.outputTokens} output`,
    s.jevAccounting
      ? `Jev totals: ${s.jevInputTokens} input, ${s.jevOutputTokens} output tokens | ${s.jevRequests} evaluations, ${s.jevAttemptsTotal} HTTP attempts, ${s.jevRetries} retries, ${s.jevFailures} failures | ${s.jevElapsedMs} ms cumulative evaluation time${s.jevUnknownUsage || s.jevUnknownAttempts ? " | usage/attempt totals incomplete" : ""}`
      : "Jev totals: not recorded (older session or no evaluator calls)",
    `Coverage: ${paused ? "manual selection" : ["adaptive-checkpoint", "adaptive-resume"].includes(s.mode) ? "supported local tools; hosted/no-tool continuations excluded" : s.mode}`,
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
    s.mode === "inactive"
      ? "INACTIVE"
      : s.jevPaused || s.policy === "manual"
        ? "PAUSED"
        : s.policy && s.policy !== "auto"
          ? "FIXED"
          : ["adaptive-checkpoint", "adaptive-resume"].includes(s.mode)
            ? "ADAPTIVE"
            : s.mode === "turn-only-resume"
              ? "PER-TURN"
              : "INACTIVE";
  return `Jev mode: ${mode} | Permissions: ${s.sandbox ?? "not selected"} | Require Jev: ${s.requireJev ? "on" : "off"}`;
}

export async function recordedSessions(
  directory = join(homedir(), ".local/share/astra-jev/logs"),
) {
  let dir;
  try {
    dir = await lstat(directory);
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
  if (!dir.isDirectory() || dir.uid !== process.getuid() || dir.mode & 0o077)
    throw new Error(
      "Decision log directory must be private and owned by this user",
    );
  const names = (await readdir(directory))
    .filter((x) => /^\d{4}-.*\.jsonl$/.test(x))
    .sort()
    .reverse();
  const sessions = [];
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
        sessions.push(
          status.snapshot({
            live: false,
            logPath: path,
            ...(offset
              ? {
                  lastError:
                    "Showing recent log records; session totals may be partial.",
                }
              : {}),
          }),
        );
    } finally {
      await file.close();
    }
  }
  return sessions.filter((s) => s.threadId);
}

export async function latestStatus(
  directory,
  { threadId = process.env.CODEX_THREAD_ID, latest = false } = {},
) {
  const sessions = await recordedSessions(directory);
  if (latest && sessions.length) return sessions[0];
  if (threadId) {
    const selected = sessions.find((s) => s.threadId === threadId);
    if (selected) return selected;
    throw new Error(
      `No recorded Astra + Jev session for thread ${threadId}; use status --list`,
    );
  }
  throw new Error(
    "Select a session: status --list, then status --thread THREAD_ID (or explicitly status --latest)",
  );
}
