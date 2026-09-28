import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { modeLabel } from "./status.mjs";

// A display-only projection of real controller decisions. Stock 0.157.1's
// completed-hook system-message renderer gives these a durable, neutral row.
// These summaries never enter App Server, hook execution, or model context.
export class EffortNotices {
  constructor({ session, emit }) {
    Object.assign(this, { session, emit });
    this.captured = session.controller?.capturedEffort ?? null;
  }
  handle(event) {
    if (event.threadId !== this.session.threadId) return;
    if (event.type === "turn_preparing") {
      this.pending = null;
      this.evaluation = null;
      if (this.session.mode)
        this.show(event, "mode", modeLabel(this.session.status()));
    }
    if (event.type === "evaluation_requested") this.evaluation = event;
    if (event.type === "decision_selected") {
      if (
        !event.evaluatedModel ||
        !this.session.controller.supportedEfforts.includes(event.effort)
      )
        return;
      const decision = { ...event, startedAt: this.evaluation?.time };
      if (!this.session.controller.captureEvents) {
        this.show(
          decision,
          "selected",
          `Jev selected ${event.effort.toUpperCase()} effort; capture unavailable on this resumed thread`,
        );
      } else if (event.effort === this.captured) {
        this.show(
          decision,
          "kept",
          `Astra kept ${event.effort.toUpperCase()} effort (Jev)`,
        );
      } else this.pending = decision;
    }
    if (event.type === "effort_captured") {
      const previous = this.captured;
      this.captured = event.effort;
      if (
        this.pending?.effort === event.effort &&
        this.pending.targetGeneration === event.targetGeneration
      ) {
        const decision = this.pending;
        this.pending = null;
        const outcome = previous === null ? "set" : "changed";
        const late =
          event.lateBy > 0
            ? `; captured ${event.lateBy} generation(s) late`
            : "";
        this.show(
          { ...decision, turnId: event.turnId },
          outcome,
          `Astra ${outcome} to ${event.effort.toUpperCase()} effort (Jev)${late}`,
        );
      }
    }
    if (event.type === "evaluation_failed") {
      this.show(
        { ...this.evaluation, ...event },
        "unavailable",
        this.captured
          ? `Jev unavailable; Astra retains ${this.captured.toUpperCase()} effort`
          : "Jev unavailable; Astra will use its fallback effort",
      );
    }
    if (
      [
        "update_failed",
        "update_unavailable",
        "update_unconfirmed",
        "turn_completed",
        "turn_interrupted",
      ].includes(event.type)
    )
      this.finish();
  }
  finish() {
    if (!this.pending) return;
    const decision = this.pending;
    this.pending = null;
    this.show(
      decision,
      "unconfirmed",
      `Jev selected ${decision.effort.toUpperCase()} effort; change unconfirmed`,
    );
  }
  show(decision, outcome, message) {
    const now = Date.now();
    const started = Date.parse(decision.startedAt ?? decision.time);
    this.emit(
      {
        method: "hook/completed",
        params: {
          threadId: this.session.threadId,
          turnId: decision.turnId ?? this.session.controller.turnId ?? null,
          run: {
            id: `astra-jev-display-${randomUUID()}`,
            eventName:
              decision.targetGeneration === 1
                ? "userPromptSubmit"
                : "postToolUse",
            handlerType: "prompt",
            executionMode: "sync",
            scope: "turn",
            source: "unknown",
            sourcePath: fileURLToPath(import.meta.url),
            displayOrder: 0,
            status: "completed",
            statusMessage: null,
            startedAt: Math.floor(
              (Number.isFinite(started) ? started : now) / 1000,
            ),
            completedAt: Math.floor(now / 1000),
            durationMs: Number.isFinite(started)
              ? Math.max(0, now - started)
              : null,
            // Codex calls a hook's neutral systemMessage a "warning" entry;
            // it renders as "Hook · message", not a warning/diagnostic banner.
            entries: [{ kind: "warning", text: message }],
          },
        },
      },
      {
        outcome,
        effort: decision.effort ?? null,
        targetGeneration: decision.targetGeneration ?? null,
      },
    );
  }
}
