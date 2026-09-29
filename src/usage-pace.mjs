// Quota windows come from Codex; no token-to-subscription estimates.
export function usagePace(limits, now = Date.now()) {
  const windows = [];
  for (const name of ["primary", "secondary"]) {
    const w = limits?.[name];
    if (
      !w ||
      !Number.isFinite(w.usedPercent) ||
      w.usedPercent < 0 ||
      w.usedPercent > 100 ||
      !Number.isFinite(w.windowDurationMins) ||
      w.windowDurationMins <= 0 ||
      !Number.isFinite(w.resetsAt)
    )
      continue;
    const duration = w.windowDurationMins * 60;
    const remaining = w.resetsAt - now / 1000;
    // Never extrapolate a new period from an expired observation.
    if (remaining <= 0 || remaining > duration) continue;
    const remainingTimePercent = (remaining / duration) * 100;
    const remainingUsagePercent = 100 - w.usedPercent;
    windows.push({
      name,
      windowDurationMins: w.windowDurationMins,
      resetsAt: w.resetsAt,
      remainingTimePercent,
      remainingUsagePercent,
      abovePace: remainingUsagePercent < remainingTimePercent - 1e-9,
    });
  }
  return {
    state: windows.some((w) => w.abovePace)
      ? "above"
      : windows.length
        ? "on-or-under"
        : "unavailable",
    windows,
  };
}

export class UsagePace {
  constructor({ request, now = Date.now }) {
    this.request = request;
    this.now = now;
    this.checkedAt = -Infinity;
    this.revision = 0;
    this.limits = null;
  }
  update(payload) {
    const limits = payload?.rateLimitsByLimitId?.codex ?? payload?.rateLimits;
    // Model-specific buckets must not override the shared Codex allowance.
    if (limits?.limitId && limits.limitId !== "codex") return;
    this.revision++;
    this.limits = limits ?? null;
    this.checkedAt = this.now();
  }
  clear() {
    this.revision++;
    this.limits = null;
    this.checkedAt = -Infinity;
  }
  snapshot() {
    return usagePace(this.limits, this.now());
  }
  async read() {
    if (this.now() - this.checkedAt >= 60_000) {
      if (!this.inFlight) {
        const revision = this.revision;
        this.inFlight = (async () => {
          let payload;
          try {
            payload = await this.request(
              "account/rateLimits/read",
              {},
              { timeoutMs: 1500 },
            );
          } catch {
            payload = null;
          }
          // A newer notification or account change wins over an older read.
          if (revision === this.revision) {
            this.limits = null;
            this.checkedAt = this.now();
            this.update(payload);
          }
        })().finally(() => {
          this.inFlight = null;
        });
      }
      await this.inFlight;
    }
    return this.snapshot();
  }
}
