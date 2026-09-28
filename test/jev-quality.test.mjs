import test from "node:test";
import assert from "node:assert/strict";
import { validateDecision } from "../src/jev.mjs";

function reply() {
  return {
    model: "jev-1.13.0",
    answers: {
      effort: {
        type: "choice",
        choice: "low",
        confidence: 0.4,
        probabilities: { low: 0.6, high: 0.4 },
      },
      lease: {
        type: "choice",
        choice: "5",
        confidence: 0.8,
        probabilities: { 1: 0.05, 2: 0.05, 5: 0.9, 10: 0 },
      },
    },
  };
}
test("uncertain effort shortens the lease without inventing a higher effort", () => {
  const response = reply();
  const decision = validateDecision(response, ["low", "high"]);
  assert.equal(decision.effort, "low");
  assert.equal(decision.selectedLeaseSteps, 5);
  assert.equal(decision.leaseSteps, 1);
  assert.equal(decision.leaseLimitedByUncertainty, true);
  assert.deepEqual(decision.effortProbabilities, { low: 0.6, high: 0.4 });
  assert.deepEqual(decision.leaseProbabilities, {
    1: 0.05,
    2: 0.05,
    5: 0.9,
    10: 0,
  });
  assert.equal(decision.leaseConfidence, 0.8);
  assert.equal(response.answers.lease.choice, "5");
  response.answers.effort.confidence = 0.5;
  const certain = validateDecision(response, ["low", "high"]);
  assert.equal(certain.leaseSteps, 5);
  assert.equal(certain.leaseLimitedByUncertainty, false);
  response.answers.lease.confidence = 0.49;
  assert.equal(validateDecision(response, ["low", "high"]).leaseSteps, 1);
});

test("diagnostic distributions exclude unexpected provider fields and malformed values", () => {
  for (const probabilities of [
    undefined,
    null,
    [],
    { low: 0.5 },
    { low: 1, high: -1 },
    { low: 0.9, high: 0.9 },
    { low: 0.6, high: 0.4, secret: "provider-text" },
  ]) {
    const response = reply();
    response.answers.effort.probabilities = probabilities;
    const decision = validateDecision(response, ["low", "high"]);
    assert.equal(decision.effortProbabilities, null);
    assert.equal(decision.effort, "low");
    assert.equal(JSON.stringify(decision).includes("provider-text"), false);
  }
  const response = reply();
  delete response.answers.effort.confidence;
  delete response.answers.lease.confidence;
  const legacy = validateDecision(response, ["low", "high"]);
  assert.equal(legacy.confidence, null);
  assert.equal(legacy.leaseConfidence, null);
  assert.equal(legacy.leaseSteps, 5);
});
