export class Controller {
  constructor({
    jev,
    rpc,
    record = () => {},
    supportedEfforts,
    context,
    captureEvents = true,
    gated = false,
    onFatal = async () => {},
    requireJev = false,
  }) {
    Object.assign(this, {
      jev,
      rpc,
      record,
      supportedEfforts,
      context,
      captureEvents,
      gated,
      onFatal,
      requireJev,
    });
    this.capturedEffort = null;
    this.active = false;
    this.revision = 0;
  }
  log(type, data = {}) {
    this.record({
      time: new Date().toISOString(),
      type,
      threadId: this.threadId,
      turnId: this.turnId ?? null,
      ...data,
    });
  }
  valid(d) {
    return (
      d &&
      this.supportedEfforts.includes(d.effort) &&
      [1, 2, 5, 10].includes(d.leaseSteps)
    );
  }
  async begin({ threadId, prompt, defaultEffort, imageCount = 0, checkpointEvent }) {
    this.abort?.abort();
    this.revision++;
    this.abort = new AbortController();
    this.active = true;
    const revision = this.revision;
    const continuing = threadId === this.threadId;
    if (!continuing) this.capturedEffort = null;
    this.threadId = threadId;
    this.turnId = null;
    this.completedGenerations = 0;
    this.responses = new Set();
    this.remaining = 0;
    this.pending = null;
    this.inFlight = null;
    this.checkpoints = new Map();
    this.generationWaiters = new Set();
    this.issuedGeneration = 0;
    this.lastCheckpointGeneration = 0;
    this.assessedFailures = 0;
    this.inputRevision = 0;
    this.requestedEffort = null;
    if (continuing) this.context.nextTurn(prompt);
    else this.context.reset(prompt);
    this.context.imageCount = imageCount;
    if (checkpointEvent) this.context.addHook(checkpointEvent);
    this.log("turn_preparing");
    let decision;
    try {
      this.log("evaluation_requested", {
        targetGeneration: 1,
        contextStats: this.context.stats(),
      });
      decision = await this.jev.decide(
        this.context.state({
          supportedEfforts: this.supportedEfforts,
          previousEffort: this.capturedEffort,
          step: 1,
          newToolFailures: 0,
        }),
        { signal: this.abort.signal },
      );
      if (!this.valid(decision)) throw new Error("Invalid Jev decision");
    } catch (e) {
      if (!this.active || revision !== this.revision)
        throw new Error("Turn cancelled");
      this.log("evaluation_failed", {
        reason: this.context.clean(e.message, 300),
      });
      if (this.requireJev) {
        this.stop();
        throw new Error(
          "Jev is required but unavailable; no model turn was started",
        );
      }
      decision = {
        effort: this.capturedEffort ?? defaultEffort,
        leaseSteps: 1,
        fallback: true,
      };
    }
    if (!this.active || revision !== this.revision)
      throw new Error("Turn cancelled");
    if (!this.supportedEfforts.includes(decision.effort))
      throw new Error("No supported fallback effort");
    this.requestedEffort = decision.effort;
    this.log("decision_selected", {
      ...decision,
      targetGeneration: 1,
      leaseApplied: this.captureEvents,
    });
    this.pending = this.captureEvents
      ? { ...decision, targetGeneration: 1, initial: true }
      : null;
    // An unchanged effort needs no new configuration item in the same live thread.
    if (decision.effort === this.capturedEffort) {
      this.remaining = decision.leaseSteps;
      this.pending = null;
    }
    return decision.effort;
  }
  attach(turnId) {
    if (this.active && !this.turnId) this.turnId = turnId;
  }
  addInput({ prompt, imageCount }) {
    if (!this.active) return;
    this.inputRevision++;
    this.context.addPrompt(prompt);
    this.context.imageCount = (this.context.imageCount ?? 0) + imageCount;
    this.remaining = 0;
    if (this.pending) this.pending.invalidated = true;
    this.log("input_steered", { contextStats: this.context.stats() });
  }
  async handle(method, p) {
    if (p.threadId !== this.threadId) return;
    if (method === "turn/started") {
      this.attach(p.turn.id);
      return;
    }
    if (!this.active) return;
    const turnId = p.turnId ?? p.turn?.id;
    if (turnId && turnId !== this.turnId) return;
    if (method === "turn/completed") {
      this.active = false;
      this.abort.abort();
      if (this.pending)
        this.log("update_unconfirmed", {
          effort: this.pending.effort,
          targetGeneration: this.pending.targetGeneration,
        });
      this.pending = null;
      this.log("turn_completed", {
        status: p.turn.status,
        generations: this.completedGenerations,
      });
      return;
    }
    if (method === "rawResponse/completed") {
      if (this.responses.has(p.responseId)) return;
      this.responses.add(p.responseId);
      this.completedGenerations++;
      for (const wake of this.generationWaiters) wake();
      if (this.remaining > 0) this.remaining--;
      this.log("generation_completed", {
        generation: this.completedGenerations,
        responseId: p.responseId,
        effort: this.capturedEffort,
        verified: this.capturedEffort !== null,
        usage: p.usage ?? null,
      });
      return;
    }
    if (method === "turn/plan/updated") {
      this.context.setPlan(p);
      return;
    }
    if (
      !this.captureEvents &&
      method === "item/completed" &&
      p.item?.type === "agentMessage"
    )
      this.context.add({
        type: "message",
        role: "assistant",
        phase: p.item.phase ?? "final_answer",
        content: [{ type: "output_text", text: p.item.text }],
      });
    if (
      method === "item/completed" &&
      (["failed", "declined"].includes(p.item?.status) ||
        (p.item?.type === "commandExecution" &&
          Number.isInteger(p.item.exitCode) &&
          p.item.exitCode !== 0))
    ) {
      this.remaining = 0;
      this.context.addFailure(p.item);
      if (this.pending) this.pending.invalidated = true;
      return;
    }
    if (method !== "rawResponseItem/completed") return;
    const item = p.item;
    if (["function_call", "custom_tool_call"].includes(item?.type))
      this.issuedGeneration = this.completedGenerations + 1;
    if (item?.type === "configuration_update") {
      const effort = item.reasoning?.effort;
      if (!this.supportedEfforts.includes(effort)) {
        this.log("unsupported_capture", {
          reason: "Codex captured an effort outside the verified Astra catalog",
        });
        this.stop();
        await this.onFatal();
        return;
      }
      this.capturedEffort = effort;
      const matches = this.pending?.effort === effort;
      const target = matches ? this.pending.targetGeneration : null;
      this.log("effort_captured", {
        effort,
        generation: this.completedGenerations + 1,
        targetGeneration: target,
        lateBy:
          target === null
            ? null
            : Math.max(0, this.completedGenerations + 1 - target),
      });
      if (matches) {
        this.remaining = this.pending.invalidated ? 0 : this.pending.leaseSteps;
        this.pending = null;
      }
      return;
    }
    this.context.add(item);
    if (
      this.gated &&
      ["function_call_output", "custom_tool_call_output"].includes(
        item?.type,
      ) &&
      this.lastCheckpointGeneration < this.completedGenerations
    )
      this.log("checkpoint_uncovered", {
        generation: this.completedGenerations,
        reason: "This output had no synchronous checkpoint; effort retained.",
      });
    if (
      this.captureEvents &&
      !this.gated &&
      ["function_call_output", "custom_tool_call_output"].includes(
        item?.type,
      ) &&
      this.remaining === 0 &&
      !this.pending &&
      this.turnId
    ) {
      return this.evaluate();
    }
  }
  async checkpoint(event, { signal } = {}) {
    if (
      !this.gated ||
      !this.active ||
      event?.session_id !== this.threadId ||
      event?.turn_id !== this.turnId ||
      typeof event?.tool_use_id !== "string" ||
      !event.tool_use_id ||
      typeof event?.tool_name !== "string"
    )
      throw new Error("Checkpoint does not belong to the active turn");
    if (event.tool_name.includes("astra_jev_checkpoint")) return;
    if (this.checkpoints.has(event.tool_use_id))
      return this.checkpoints.get(event.tool_use_id);
    const revision = this.revision;
    const combined = signal
      ? AbortSignal.any([this.abort.signal, signal])
      : this.abort.signal;
    const run = async () => {
      this.context.addHook(event);
      // Resume has no raw generation stream. Reassess each distinct local
      // checkpoint, and invalidate a judgment if parallel evidence arrives.
      if (!this.captureEvents) this.inputRevision++;
      this.log("checkpoint_started", {
        tool: this.context.clean(event.tool_name, 120),
        completedGenerations: this.completedGenerations,
      });
      // Tools can finish while their issuing response is still streaming.
      const issuing = Math.max(1, this.issuedGeneration);
      if (this.captureEvents && this.completedGenerations < issuing)
        await new Promise((resolve, reject) => {
          const cleanup = () => {
            this.generationWaiters.delete(wake);
            combined.removeEventListener("abort", cancel);
          };
          const wake = () => {
            if (this.completedGenerations >= issuing) {
              cleanup();
              resolve();
            }
          };
          const cancel = () => {
            cleanup();
            reject(new Error("Checkpoint cancelled"));
          };
          this.generationWaiters.add(wake);
          combined.addEventListener("abort", cancel, { once: true });
          if (combined.aborted) cancel();
          else wake();
        });
      if (combined.aborted || !this.active || this.revision !== revision)
        throw new Error("Checkpoint cancelled");
      this.lastCheckpointGeneration = this.completedGenerations;
      if (this.inFlight) await this.inFlight;
      else if (!this.captureEvents || (this.remaining === 0 && !this.pending))
        await this.evaluate({ signal: combined });
      if (combined.aborted || !this.active || this.revision !== revision)
        throw new Error("Checkpoint cancelled");
      this.log("checkpoint_released", {
        targetGeneration: this.captureEvents
          ? this.completedGenerations + 1
          : null,
      });
    };
    const pending = run();
    this.checkpoints.set(event.tool_use_id, pending);
    return pending;
  }
  async evaluate({ signal = this.abort.signal } = {}) {
    if (this.inFlight) return this.inFlight;
    const revision = this.revision,
      turnId = this.turnId,
      targetGeneration = this.captureEvents
        ? this.completedGenerations + 1
        : null;
    const run = async () => {
      let stage = "evaluation";
      try {
        const failures = this.context.failures.size;
        const inputRevision = this.inputRevision;
        this.log("evaluation_requested", {
          targetGeneration,
          contextStats: this.context.stats(),
        });
        const decision = await this.jev.decide(
          this.context.state({
            supportedEfforts: this.supportedEfforts,
            previousEffort: this.captureEvents
              ? this.capturedEffort
              : this.requestedEffort,
            step: targetGeneration,
            newToolFailures: failures - this.assessedFailures,
          }),
          { signal },
        );
        if (
          !this.active ||
          signal.aborted ||
          revision !== this.revision ||
          turnId !== this.turnId
        ) {
          this.log("decision_discarded", {
            targetGeneration,
            reason: "Turn changed or finished",
          });
          return;
        }
        if (inputRevision !== this.inputRevision) {
          this.log("decision_discarded", {
            targetGeneration,
            reason: "Evaluation context changed",
          });
          return run();
        }
        if (!this.valid(decision)) throw new Error("Invalid Jev decision");
        this.assessedFailures = failures;
        this.log("decision_selected", {
          ...decision,
          targetGeneration,
          leaseApplied: this.captureEvents,
        });
        const invalidated = this.context.failures.size > failures;
        const previous = this.captureEvents
          ? this.capturedEffort
          : this.requestedEffort;
        if (decision.effort === previous) {
          this.remaining =
            this.captureEvents && !invalidated ? decision.leaseSteps : 0;
          this.log("effort_retained", {
            effort: decision.effort,
            leaseSteps: decision.leaseSteps,
          });
          return;
        }
        this.pending = this.captureEvents
          ? { ...decision, targetGeneration, invalidated }
          : null;
        stage = "publication";
        let result;
        try {
          result = await this.rpc(
            "turn/settings/update",
            {
              threadId: this.threadId,
              turnId,
              effort: decision.effort,
            },
            { timeoutMs: 4000 },
          );
        } catch (error) {
          // An unacknowledged update might still be queued. Stop its turn before
          // releasing the native checkpoint rather than allow a late change.
          if (this.gated) {
            this.stop();
            await this.onFatal();
          }
          throw error;
        }
        if (!this.active || revision !== this.revision) {
          this.log("update_finished_after_turn", {
            effort: decision.effort,
            status: result.status,
          });
          return;
        }
        if (result.status !== "applied") {
          this.pending = null;
          this.log("update_unavailable", {
            effort: decision.effort,
            status: result.status,
          });
          if (this.requireJev)
            throw new Error("Required Jev update was not applied");
          return;
        }
        this.requestedEffort = decision.effort;
        this.log("update_published", {
          effort: decision.effort,
          targetGeneration,
        });
        // Another resumed tool may finish while Codex acknowledges this
        // update. Assess that evidence before releasing either checkpoint.
        if (!this.captureEvents && inputRevision !== this.inputRevision)
          return run();
      } catch (e) {
        if (revision !== this.revision) return;
        this.pending = null;
        this.log(
          stage === "publication" ? "update_failed" : "evaluation_failed",
          {
            reason: this.context.clean(e.message, 300),
            retainedEffort: this.capturedEffort,
          },
        );
        if (this.requireJev) {
          if (this.active) {
            this.stop();
            await this.onFatal();
          }
          return;
        }
        // Retry at the next generation boundary, rather than every parallel output.
        this.remaining = 1;
      }
    };
    this.inFlight = run().finally(() => {
      if (revision === this.revision) this.inFlight = null;
    });
    return this.inFlight;
  }
  stop() {
    this.active = false;
    this.abort?.abort();
  }
}
