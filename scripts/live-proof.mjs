import { mkdtempSync, writeFileSync, readFileSync, mkdirSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { Session } from "../src/session.mjs";
import { Jev, loadKey } from "../src/jev.mjs";

const key = loadKey(),
  workspace = mkdtempSync(join(tmpdir(), "astra-jev-live-"));
const config = [
  "project_doc_max_bytes=0",
  "features.apps=false",
  "features.plugins=false",
];
const localConfig = readFileSync(join(homedir(), ".codex/config.toml"), "utf8");
for (const m of localConfig.matchAll(/^\[mcp_servers\.([\w-]+)\]/gm))
  config.push(`mcp_servers.${m[1]}.enabled=false`);
for (let i = 1; i <= 4; i++)
  writeFileSync(
    join(workspace, `step-${i}.txt`),
    `Label: ${["ALPHA", "BRAVO", "CHARLIE", "DELTA"][i - 1]}.\n${i < 4 ? `Next: read step-${i + 1}.txt.` : "Finish: output exactly ALPHA BRAVO CHARLIE DELTA."}\n`,
  );
const prompt =
  "Read step-1.txt and follow its instructions. Use one native shell read per execution cell; return each result to yourself before taking the next step. Do not inspect other files, write files, use loops, or batch reads.";
const reports = [];
async function run(
  name,
  { fixedEffort = null, resume, promptText = prompt, expectedOutput } = {},
) {
  const records = [],
    notices = [];
  const session = new Session({
    cwd: workspace,
    config,
    jev: new Jev({ key }),
    secrets: [key],
    fixedEffort,
    record: (x) => records.push(x),
    onNotice: (x) => notices.push(x),
    threadOptions: {
      sandbox: "read-only",
      approvalPolicy: "never",
      developerInstructions:
        "Synthetic local integration test. Only perform the user-requested reads of synthetic fixtures. One shell read per code-mode execution; return its result to the model. No other tools, no file writes, no delegation.",
    },
  });
  const started = Date.now();
  let timeout;
  try {
    const info = await session.open({ resume });
    timeout = setTimeout(() => {
      void session.interrupt();
    }, 90000);
    const result = await session.run(promptText);
    const expected =
      expectedOutput ?? (resume ? "RESUME_OK" : "ALPHA BRAVO CHARLIE DELTA");
    const summary = {
      name,
      ...info,
      status: result.status,
      output: result.text,
      outputPassed: result.text.includes(expected),
      elapsedMs: Date.now() - started,
      decisions: records.filter((x) => x.type === "decision_selected"),
      captures: records.filter((x) => x.type === "effort_captured"),
      generations: records.filter((x) => x.type === "generation_completed"),
      failures: records.filter((x) =>
        [
          "evaluation_failed",
          "update_unavailable",
          "update_unconfirmed",
          "decision_discarded",
        ].includes(x.type),
      ),
      resumedEventLimitation: notices.some((x) =>
        x.includes("does not expose raw generation events"),
      ),
    };
    reports.push(summary);
    console.log(
      JSON.stringify({
        name,
        threadId: info.threadId,
        mode: info.mode,
        passed: summary.outputPassed,
        elapsedMs: summary.elapsedMs,
        generations: summary.generations.length,
        decisions: summary.decisions.length,
        captures: summary.captures.map((x) => ({
          effort: x.effort,
          generation: x.generation,
          lateBy: x.lateBy,
        })),
        failures: summary.failures.map((x) => x.type),
      }),
    );
    return info.threadId;
  } finally {
    clearTimeout(timeout);
    await session.close();
  }
}
try {
  const thread = await run("adaptive-native-tools");
  await run("fixed-high-native-tools", { fixedEffort: "high" });
  await run("resume", {
    resume: thread,
    promptText: "Reply exactly RESUME_OK. Do not use tools.",
  });
  writeFileSync(
    join(workspace, "transition-1.txt"),
    "Analyze whether this two-location transfer algorithm preserves total balance under interleaving, and whether rollback can recover exactly once after a crash. Initial A=100, B=100. Operation transfer(id,amount) reads A and B, writes A-amount, writes B+amount, then writes id into a dedup set. Two workers may execute the same id concurrently; a crash can occur after any write. First read transition-2.txt for the requested output before analyzing.",
  );
  writeFileSync(
    join(workspace, "transition-2.txt"),
    "Give one concrete violating interleaving, identify the linearization problem, and state the minimum durable atomicity requirement to fix retries. Think through duplicate execution and a crash separately. Then read transition-3.txt for a final formatting instruction.",
  );
  writeFileSync(
    join(workspace, "transition-3.txt"),
    "Answer concisely using the two cases and the durable requirement; end with TRANSITION_OK.",
  );
  await run("adaptive-complexity-transition", {
    promptText:
      "Read transition-1.txt and follow its instructions. One file read per execution cell, returning each result to the model. No other files or writes.",
    expectedOutput: "TRANSITION_OK",
  });
} catch (e) {
  reports.push({ error: e.message });
  console.error(e.message);
  process.exitCode = 1;
}
const out = new URL("../verification/", import.meta.url);
mkdirSync(out, { recursive: true });
writeFileSync(
  new URL("live-results.json", out),
  JSON.stringify(
    {
      timestamp: new Date().toISOString(),
      workspace,
      codexVersion: "0.157.1",
      reports,
    },
    null,
    2,
  ),
  { mode: 0o600 },
);
if (reports.some((x) => x.error || x.outputPassed === false))
  process.exitCode = 1;
