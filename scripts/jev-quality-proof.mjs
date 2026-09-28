import { readFileSync, writeFileSync } from "node:fs";
import { Jev, loadKey } from "../src/jev.mjs";
import { qualityCases, qualityState } from "../fixtures/jev-quality-cases.mjs";

const baseline = JSON.parse(
  readFileSync(new URL("../fixtures/jev-policy-v1.json", import.meta.url)),
);
const key = loadKey();
const reports = [];
for (const c of qualityCases) {
  const pair = { id: c.id, accepted: c.accepted };
  for (const policy of ["baseline", "candidate"]) {
    const evaluator = new Jev({
      key,
      fetchImpl: (url, options) => {
        if (policy === "baseline") {
          const body = JSON.parse(options.body);
          body.questions = baseline;
          delete body.state.userPromptIndex;
          for (const tool of body.state.recentToolCalls ?? []) {
            delete tool.diagnosticExcerpt;
            delete tool.omittedDiagnosticExcerpts;
            delete tool.userPromptIndex;
          }
          options = { ...options, body: JSON.stringify(body) };
        }
        return fetch(url, options);
      },
    });
    const decision = await evaluator.decide(qualityState(c));
    pair[policy] = {
      ...decision,
      accepted: c.accepted.includes(decision.effort),
    };
  }
  reports.push(pair);
  console.log(
    JSON.stringify({
      id: c.id,
      baseline: pair.baseline.effort,
      candidate: pair.candidate.effort,
      accepted: pair.candidate.accepted,
    }),
  );
}
const result = {
  date: new Date().toISOString(),
  scope:
    "Synthetic review-labelled decisions; not task success, security certification, or cost savings. Baseline uses frozen v1 questions; candidate uses installed questions. Score uses effort, not lease postprocessing.",
  total: reports.length,
  baselineAccepted: reports.filter((x) => x.baseline.accepted).length,
  candidateAccepted: reports.filter((x) => x.candidate.accepted).length,
  reports,
};
writeFileSync(
  new URL("../verification/jev-quality.json", import.meta.url),
  JSON.stringify(result, null, 2) + "\n",
);
console.log(
  JSON.stringify({
    total: result.total,
    baselineAccepted: result.baselineAccepted,
    candidateAccepted: result.candidateAccepted,
  }),
);
if (result.candidateAccepted !== result.total) process.exitCode = 1;
