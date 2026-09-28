import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { Status, latestStatus } from "../src/status.mjs";
import { estimateCost, summarize } from "../scripts/benchmark-lib.mjs";
test("accounting includes failed and discarded evaluations without changing captured effort", () => {
  const s = new Status();
  assert.equal(s.snapshot().jevRequests, 0);
  s.update({
    type: "jev_evaluation",
    success: true,
    attempts: 2,
    elapsedMs: 400,
    usage: { input_tokens: 100, output_tokens: 20 },
  });
  s.update({
    type: "jev_evaluation",
    success: false,
    attempts: 1,
    elapsedMs: 800,
    usage: null,
  });
  const v = s.snapshot();
  assert.equal(v.jevRequests, 2);
  assert.equal(v.jevAttemptsTotal, 3);
  assert.equal(v.jevRetries, 1);
  assert.equal(v.jevFailures, 1);
  assert.equal(v.jevElapsedMs, 1200);
  assert.equal(v.jevInputTokens, 100);
  assert.equal(v.jevUnknownUsage, 2);
  assert.equal(v.capturedEffort, null);
});
test("recorded status never falls back to another thread", async () => {
  const dir = await mkdtemp("/tmp/astra-status-");
  try {
    for (const [name, id] of [
      ["2026-01", "old"],
      ["2026-02", "new"],
    ])
      await writeFile(
        `${dir}/${name}.jsonl`,
        JSON.stringify({ type: "session_opened", threadId: id }) + "\n",
        { mode: 0o600 },
      );
    assert.equal(
      (await latestStatus(dir, { threadId: "old" })).threadId,
      "old",
    );
    await assert.rejects(
      latestStatus(dir, { threadId: "missing" }),
      /No recorded/,
    );
    await assert.rejects(latestStatus(dir, { threadId: null }), /Select/);
    assert.equal((await latestStatus(dir, { latest: true })).threadId, "new");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test("cost estimates include failed tasks and refuse missing usage", () => {
  const rates = {
    astraInput: 2,
    astraCachedInput: 1,
    astraOutput: 3,
    jevInput: 1,
    jevOutput: 2,
  };
  const metrics = {
    astra: { input: 100, cached: 20, output: 10, complete: true },
    jev: { input: 20, output: 5, complete: true, elapsedMs: 10 },
    integrationFailures: 0,
  };
  assert.equal(estimateCost(metrics, rates), 240 / 1e6);
  const rows = [true, false].map((passed) => ({
    policy: "adaptive",
    passed,
    metrics,
    elapsedMs: 100,
  }));
  assert.equal(
    summarize(rows, rates)[0].estimatedUsdPerSuccessfulTask,
    480 / 1e6,
  );
  metrics.jev.complete = false;
  assert.equal(estimateCost(metrics, rates), null);
});

test("long homes resolve to a private short socket directory without weakening ownership", async () => {
  const { spawnSync } = await import("node:child_process");
  const script = `import {sessionSocket} from ${JSON.stringify(new URL("../src/persistent.mjs", import.meta.url).href)};import {lstat,rmdir} from 'node:fs/promises';import {dirname} from 'node:path';const p=await sessionSocket('proof');const s=await lstat(dirname(p));console.log(JSON.stringify({bytes:Buffer.byteLength(p),mode:s.mode&511,uid:s.uid}));await rmdir(dirname(p));`;
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    encoding: "utf8",
    env: {
      ...process.env,
      HOME: "/tmp/" + `long-home-${process.pid}-`.repeat(12),
    },
  });
  assert.equal(r.status, 0, r.stderr);
  const v = JSON.parse(r.stdout);
  assert.equal(v.bytes <= 103, true);
  assert.equal(v.mode, 448);
  assert.equal(v.uid, process.getuid());
});
