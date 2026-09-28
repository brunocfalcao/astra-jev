import assert from "node:assert/strict";
import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  existsSync,
} from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { Session } from "../src/session.mjs";
import { Jev, loadKey } from "../src/jev.mjs";

const workspace = mkdtempSync(join(tmpdir(), "astra-jev-checkpoint-proof-"));
const config = [
  "project_doc_max_bytes=0",
  "features.apps=false",
  "features.plugins=false",
];
for (const match of readFileSync(
  join(homedir(), ".codex/config.toml"),
  "utf8",
).matchAll(/^\[mcp_servers\.([\w-]+)\]/gm))
  config.push(`mcp_servers.${match[1]}.enabled=false`);
writeFileSync(
  join(workspace, "first.txt"),
  "First label ALPHA. Read second.txt next, in a new execution cell.",
);
writeFileSync(
  join(workspace, "second.txt"),
  "Second label BETA. Finish exactly ALPHA BETA.",
);
const records = [],
  notices = [];
let calls = 0;
const real = process.argv.includes("--jev");
const parallel = process.argv.includes("--parallel");
const complex = process.argv.includes("--complex");
const toolFailure = process.argv.includes("--tool-failure");
if (complex) {
  writeFileSync(
    join(workspace, "first.txt"),
    "Analyze this transfer algorithm for concurrency and crash safety: A=100, B=100. transfer(id,amount) reads A and B, writes A-amount, writes B+amount, then adds id to a dedup set. Two workers can execute the same id concurrently. Crashes can occur after any write. Read second.txt for the requested answer before analyzing.",
  );
  writeFileSync(
    join(workspace, "second.txt"),
    "Give a concrete violating interleaving, a crash/retry counterexample, and the minimum durable atomicity requirement. Finish with TRANSITION_OK.",
  );
}
const key = real ? loadKey() : null;
const evaluator = real
  ? new Jev({ key })
  : {
      decide: async () => {
        const index = calls++;
        if (index) await delay(450);
        return {
          effort: index === 1 ? "high" : "low",
          leaseSteps: toolFailure && index === 0 ? 10 : 1,
        };
      },
    };
const session = new Session({
  cwd: workspace,
  config,
  jev: evaluator,
  secrets: key ? [key] : [],
  record: (event) => {
    records.push(event);
    console.log(JSON.stringify(event));
  },
  onNotice: (text) => {
    notices.push(text);
    console.error(text.slice(0, 450));
  },
  threadOptions: {
    sandbox: "read-only",
    approvalPolicy: "never",
    developerInstructions: toolFailure
      ? "Synthetic native failure test. Only attempt to read the intentionally absent missing-file.txt once, then answer as requested. No other tools, retries or delegation."
      : "Synthetic local test. Read only the two requested fixture files with native shell tools and use the requested execution order. No other tools or delegation.",
  },
});
let timeout, info, snapshotSettings, snapshotFiles;
try {
  info = await session.open();
  const effective = await session.transport.request("config/read", {
    includeLayers: false,
    cwd: workspace,
  });
  snapshotSettings = {
    shell_snapshot: effective.config.features?.shell_snapshot,
    shell_snapshot_v2: effective.config.features?.shell_snapshot_v2,
  };
  assert.deepEqual(snapshotSettings, {
    shell_snapshot: false,
    shell_snapshot_v2: false,
  });
  timeout = setTimeout(() => {
    void session.interrupt();
  }, 65000);
  const result = await session.run(
    toolFailure
      ? "Read missing-file.txt once with a native shell tool. It is intentionally absent. After the failure, reply exactly FAILURE_OK. Do not retry."
      : parallel
        ? "Read first.txt and second.txt in parallel in one execution cell using two native shell tool calls with Promise.all. Ignore the sequential-read instructions inside the files. Output exactly ALPHA BETA."
        : "Read first.txt and follow its instructions. One file per execution cell.",
  );
  assert.ok(
    result.text.includes(
      toolFailure ? "FAILURE_OK" : complex ? "TRANSITION_OK" : "ALPHA BETA",
    ),
  );
  const snapshotDirectory = join(homedir(), ".codex/shell_snapshots");
  snapshotFiles = existsSync(snapshotDirectory)
    ? readdirSync(snapshotDirectory).filter((name) =>
        name.startsWith(info.threadId + "."),
      )
    : [];
  assert.equal(snapshotFiles.length, 0);
  assert.ok(
    records.some((x) => x.type === "checkpoint_released"),
    "Native hooks must actually run",
  );
  assert.equal(
    records.filter((x) => x.type === "update_unconfirmed").length,
    0,
  );
  if (!real)
    assert.deepEqual(
      records
        .filter((x) => x.type === "generation_completed")
        .map((x) => x.effort),
      parallel || toolFailure ? ["low", "high"] : ["low", "high", "low"],
    );
  assert.ok(
    records
      .filter((x) => x.type === "effort_captured")
      .every((x) => x.lateBy === 0 || x.lateBy === null),
  );
  console.log(
    JSON.stringify({
      passed: true,
      realJev: real,
      threadId: info.threadId,
      output: result.text,
    }),
  );
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  clearTimeout(timeout);
  await session.close();
  writeFileSync(
    new URL(
      `../verification/checkpoint-${toolFailure ? "tool-failure" : complex ? "complex" : parallel ? "parallel" : real ? "jev" : "control"}.json`,
      import.meta.url,
    ),
    JSON.stringify(
      {
        workspace,
        info,
        passed: !process.exitCode,
        snapshotSettings,
        snapshotFiles,
        records,
        notices,
      },
      null,
      2,
    ),
    { mode: 0o600 },
  );
}
