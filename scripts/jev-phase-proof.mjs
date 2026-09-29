import { readFileSync, writeFileSync } from "node:fs";
import { Jev, loadKey } from "../src/jev.mjs";
import { phaseCases, phaseState } from "../fixtures/jev-phase-cases.mjs";
import { qualityCases, qualityState } from "../fixtures/jev-quality-cases.mjs";

const baseline = JSON.parse(
  readFileSync(new URL("../fixtures/jev-policy-v2.json", import.meta.url)),
);
const baselineOnly = process.argv.includes("--baseline-only");
const key = loadKey();
const reports = [];
const cases = baselineOnly ? phaseCases : [...phaseCases, ...qualityCases];
for (let round = 1; round <= 3; round++) {
  for (const c of cases) {
    const state = phaseCases.includes(c) ? phaseState(c) : qualityState(c);
    const pair = { id: c.id, round, accepted: c.accepted };
    // Alternate ordering to avoid consistently favoring one policy in time.
    const policies = baselineOnly
      ? ["baseline"]
      : round % 2
        ? ["baseline", "candidate"]
        : ["candidate", "baseline"];
    for (const policy of policies) {
      const evaluator = new Jev({
        key,
        fetchImpl: (url, options) => {
          if (policy === "baseline") {
            const body = JSON.parse(options.body);
            body.questions = baseline;
            options = { ...options, body: JSON.stringify(body) };
          }
          return fetch(url, options);
        },
      });
      const decision = await evaluator.decide(state);
      pair[policy] = {
        ...decision,
        policyVersion:
          policy === "baseline" ? "effort-v2" : decision.policyVersion,
        accepted: c.accepted.includes(decision.effort),
      };
    }
    reports.push(pair);
    console.log(
      JSON.stringify({
        id: c.id,
        round,
        baseline: pair.baseline.effort,
        candidate: pair.candidate?.effort,
      }),
    );
  }
}
const result = {
  date: new Date().toISOString(),
  scope:
    "Synthetic review-labelled phase decisions, three repetitions; not exact historical replays, task-success measurements or cost savings.",
  total: reports.length,
  baselineAccepted: reports.filter((x) => x.baseline.accepted).length,
  candidateAccepted: baselineOnly
    ? null
    : reports.filter((x) => x.candidate.accepted).length,
  reports,
};
writeFileSync(
  new URL(
    `../verification/jev-phase-${baselineOnly ? "baseline" : "paired"}.json`,
    import.meta.url,
  ),
  JSON.stringify(result, null, 2) + "\n",
);
console.log(
  JSON.stringify({
    total: result.total,
    baselineAccepted: result.baselineAccepted,
    candidateAccepted: result.candidateAccepted,
  }),
);
if (
  (baselineOnly ? result.baselineAccepted : result.candidateAccepted) !==
  result.total
)
  process.exitCode = 1;
