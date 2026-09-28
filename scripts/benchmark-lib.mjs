import { Status } from "../src/status.mjs";

export function validateRates(rates) {
  if (
    !rates ||
    typeof rates.source !== "string" ||
    !rates.source.trim() ||
    !/^\d{4}-\d{2}-\d{2}$/.test(rates.asOf ?? "")
  )
    throw new Error("Rates need source and asOf (YYYY-MM-DD)");
  for (const key of [
    "astraInput",
    "astraCachedInput",
    "astraOutput",
    "jevInput",
    "jevOutput",
  ])
    if (!Number.isFinite(rates[key]) || rates[key] < 0)
      throw new Error(`Invalid USD per million token rate: ${key}`);
  return rates;
}
export function measure(records) {
  const tracker = new Status();
  for (const event of records) tracker.update(event);
  const s = tracker.snapshot();
  const generations = records.filter((e) => e.type === "generation_completed");
  const astraUsageComplete =
    generations.length > 0 &&
    generations.every(
      (e) =>
        [
          e.usage?.inputTokens,
          e.usage?.cachedInputTokens,
          e.usage?.outputTokens,
        ].every((v) => Number.isSafeInteger(v) && v >= 0) &&
        e.usage.cachedInputTokens <= e.usage.inputTokens,
    );
  return {
    astra: {
      input: s.inputTokens,
      cached: s.cachedInputTokens,
      output: s.outputTokens,
      complete: astraUsageComplete,
    },
    jev: {
      input: s.jevInputTokens,
      output: s.jevOutputTokens,
      evaluations: s.jevRequests,
      attempts: s.jevAttemptsTotal,
      retries: s.jevRetries,
      failures: s.jevFailures,
      elapsedMs: s.jevElapsedMs,
      complete: !s.jevUnknownUsage && !s.jevUnknownAttempts,
    },
    integrationFailures: records.filter((e) =>
      [
        "evaluation_failed",
        "update_failed",
        "update_unavailable",
        "update_unconfirmed",
        "checkpoint_failed",
      ].includes(e.type),
    ).length,
  };
}
export function estimateCost(metrics, rates) {
  if (!rates || !metrics.astra.complete || !metrics.jev.complete) return null;
  const a = metrics.astra,
    j = metrics.jev;
  return (
    ((a.input - a.cached) * rates.astraInput +
      a.cached * rates.astraCachedInput +
      a.output * rates.astraOutput +
      j.input * rates.jevInput +
      j.output * rates.jevOutput) /
    1e6
  );
}
export function summarize(reports, rates) {
  return ["adaptive", "fixed-high"].map((policy) => {
    const rows = reports.filter((r) => r.policy === policy);
    const successes = rows.filter((r) => r.passed).length;
    const costs = rows.map((r) => estimateCost(r.metrics, rates));
    const total =
      costs.length && costs.every((c) => c !== null)
        ? costs.reduce((a, b) => a + b, 0)
        : null;
    const usage = rows.reduce(
      (sum, r) => {
        sum.astraInput += r.metrics.astra.input;
        sum.astraCached += r.metrics.astra.cached;
        sum.astraOutput += r.metrics.astra.output;
        sum.jevInput += r.metrics.jev.input;
        sum.jevOutput += r.metrics.jev.output;
        return sum;
      },
      {
        astraInput: 0,
        astraCached: 0,
        astraOutput: 0,
        jevInput: 0,
        jevOutput: 0,
      },
    );
    return {
      policy,
      usage,
      runs: rows.length,
      successes,
      integrationFailures: rows.reduce(
        (sum, r) => sum + r.metrics.integrationFailures,
        0,
      ),
      elapsedMs: rows.reduce((sum, r) => sum + r.elapsedMs, 0),
      jevEvaluationMs: rows.reduce(
        (sum, r) => sum + r.metrics.jev.elapsedMs,
        0,
      ),
      estimatedUsd: total,
      estimatedUsdPerSuccessfulTask:
        total !== null && successes ? total / successes : null,
    };
  });
}
