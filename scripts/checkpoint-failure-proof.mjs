import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { Session } from "../src/session.mjs";

const cwd = await mkdtemp("/tmp/astra-jev-hook-failure-proof-");
await writeFile(
  join(cwd, "sample.txt"),
  "Synthetic fixture. After this read, explain transaction isolation carefully.\n",
);
const records = [],
  hookRuns = [];
const session = new Session({
  cwd,
  jev: { decide: async () => ({ effort: "low", leaseSteps: 1 }) },
  record: (event) => records.push(event),
  threadOptions: {
    sandbox: "read-only",
    approvalPolicy: "never",
    developerInstructions:
      "Synthetic local checkpoint failure test. Read only sample.txt with one native tool call. No other tools or delegation.",
  },
});
session.transport.on("notification", ({ method, params }) => {
  if (method === "hook/completed" && session.bridge?.ownsRun(params.run))
    hookRuns.push({
      status: params.run.status,
      source: params.run.source,
      eventName: params.run.eventName,
    });
});
let result = { passed: false },
  timer;
try {
  await session.open();
  // Fault injection belongs only to this synthetic Session; no native file or
  // user's hook configuration is modified.
  session.controller.checkpoint = async () => {
    throw new Error("Synthetic checkpoint rejection");
  };
  timer = setTimeout(() => {
    void session.interrupt();
  }, 30000);
  const turn = await session.run(
    "Read sample.txt once with a native shell tool, then follow its instructions.",
  );
  assert.equal(turn.status, "interrupted");
  assert.ok(hookRuns.some((x) => ["failed", "stopped"].includes(x.status)));
  assert.ok(records.some((x) => x.type === "checkpoint_failed"));
  await assert.rejects(() => session.run("Continue"), /checkpoint.*restart/i);
  result = {
    passed: true,
    threadId: session.threadId,
    turnStatus: turn.status,
    hookRuns,
    completedGenerations: records.filter(
      (x) => x.type === "generation_completed",
    ).length,
    furtherAdaptiveTurnsBlocked: true,
  };
} finally {
  clearTimeout(timer);
  await session.close();
  await rm(cwd, { recursive: true, force: true });
  await writeFile(
    new URL("../verification/checkpoint-failure.json", import.meta.url),
    JSON.stringify(result, null, 2) + "\n",
    { mode: 0o600 },
  );
  console.log(JSON.stringify(result));
}
