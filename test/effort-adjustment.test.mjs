import test from "node:test";
import assert from "node:assert/strict";
import { applyEffortAdjustment } from "../src/session.mjs";

const supported = ["low", "medium", "high", "xhigh", "max", "ultra"];

test("effort adjustment preserves Jev evidence and applies the supported floor and ceiling", () => {
  const original = { effort: "ultra", leaseSteps: 5, evaluatedModel: "jev-test" };
  const optimistic = applyEffortAdjustment(original, "optimistic", supported);
  assert.deepEqual(original, {
    effort: "ultra",
    leaseSteps: 5,
    evaluatedModel: "jev-test",
  });
  assert.deepEqual(optimistic, {
    effort: "max",
    jevEffort: "ultra",
    effortAdjustment: "optimistic",
    leaseSteps: 5,
    evaluatedModel: "jev-test",
  });
  assert.equal(
    applyEffortAdjustment({ effort: "low" }, "conservative", supported).effort,
    "low",
  );
  assert.equal(
    applyEffortAdjustment({ effort: "high" }, "conservative", supported)
      .effort,
    "medium",
  );
  assert.equal(
    applyEffortAdjustment({ effort: "high" }, "default", supported).effort,
    "high",
  );
  assert.equal(
    applyEffortAdjustment({ effort: "max" }, "optimistic", supported).effort,
    "max",
  );
  assert.equal(
    applyEffortAdjustment(
      { effort: "high" },
      "optimistic",
      ["low", "high"],
    ).effort,
    "high",
  );
  assert.throws(
    () => applyEffortAdjustment({ effort: "unsupported" }, "default", supported),
    /Unsupported Jev effort/,
  );
});
