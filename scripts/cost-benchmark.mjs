#!/usr/bin/env -S node --use-system-ca
import {
  mkdtemp,
  writeFile,
  mkdir,
  rm,
  readFile,
  rename,
} from "node:fs/promises";
import { join, resolve, dirname } from "node:path";
import { tmpdir, homedir } from "node:os";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { Session } from "../src/session.mjs";
import { Jev } from "../src/jev.mjs";
import { ensureKey } from "../src/onboarding.mjs";
import { benchmarkCases } from "../fixtures/benchmark-cases.mjs";
import { measure, validateRates, summarize } from "./benchmark-lib.mjs";

const args = process.argv.slice(2);
if (args.includes("--help")) {
  console.log(
    "node --use-system-ca scripts/cost-benchmark.mjs [--repetitions EVEN_NUMBER] [--output NEW_DIRECTORY] [--rates JSON_FILE]\nOpt-in paid native benchmark: three coding tasks, both policies, balanced order. Uses normal privacy consent and credentials. No rates are assumed.",
  );
  process.exit(0);
}
let repetitions = 4,
  output = resolve(`verification/benchmark-${Date.now()}`),
  rates;
for (let i = 0; i < args.length; i += 2) {
  if (!args[i + 1]) throw new Error("Missing option value");
  if (args[i] === "--repetitions") repetitions = Number(args[i + 1]);
  else if (args[i] === "--output") output = resolve(args[i + 1]);
  else if (args[i] === "--rates")
    rates = validateRates(JSON.parse(await readFile(args[i + 1], "utf8")));
  else throw new Error("Unknown benchmark option");
}
if (
  !Number.isInteger(repetitions) ||
  repetitions < 2 ||
  repetitions > 20 ||
  repetitions % 2
)
  throw new Error("Repetitions must be even, from 2 through 20");
const key = await ensureKey();
if (!key) throw new Error("Benchmark cancelled: no Jev key");
await mkdir(dirname(output), { recursive: true });
await mkdir(output, { mode: 0o700 });
const config = [
  "project_doc_max_bytes=0",
  "features.apps=false",
  "features.plugins=false",
];
try {
  const configText = await readFile(
    join(process.env.CODEX_HOME || join(homedir(), ".codex"), "config.toml"),
    "utf8",
  );
  for (const m of configText.matchAll(/^\[mcp_servers\.([\w-]+)\]/gm))
    config.push(`mcp_servers.${m[1]}.enabled=false`);
} catch (e) {
  if (e.code !== "ENOENT") throw e;
}
const reports = [];
let interrupted = false,
  active;
const stop = () => {
  interrupted = true;
  void active?.interrupt().catch(() => {});
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
const report = {
  startedAt: new Date().toISOString(),
  node: process.version,
  codex: spawnSync("codex", ["--version"], { encoding: "utf8" }).stdout?.trim(),
  repetitions,
  rates: rates ?? null,
  scope:
    "Fresh sessions; synthetic coding tasks; balanced order, independent acceptance checks. Cache counts retained; cache is not controlled. Estimates are not subscription charges. Missing usage prevents cost claims. Failed task costs remain in the numerator. No statistical equivalence claim.",
  reports,
};
async function save() {
  report.summary = summarize(reports, rates);
  report.complete =
    !interrupted && reports.length === repetitions * benchmarkCases.length * 2;
  await writeFile(
    join(output, "report.tmp"),
    JSON.stringify(report, null, 2) + "\n",
    { mode: 0o600 },
  );
  await rename(join(output, "report.tmp"), join(output, "report.json"));
}
try {
  for (
    let repetition = 0;
    repetition < repetitions && !interrupted;
    repetition++
  ) {
    for (const task of benchmarkCases) {
      const order =
        repetition % 2
          ? ["fixed-high", "adaptive"]
          : ["adaptive", "fixed-high"];
      for (const policy of order) {
        if (interrupted) break;
        const cwd = await mkdtemp(join(tmpdir(), "astra-benchmark-"));
        for (const [name, text] of Object.entries(task.files))
          await writeFile(join(cwd, name), text);
        const records = [];
        const session = new Session({
          cwd,
          config: [...config],
          jev: new Jev({ key }),
          secrets: [key],
          requireJev: policy === "adaptive",
          fixedEffort: policy === "fixed-high" ? "high" : null,
          record: (e) => records.push(e),
          threadOptions: {
            sandbox: "workspace-write",
            approvalPolicy: "never",
            developerInstructions:
              "Work only on the named synthetic fixture. No network, delegation, external files or dependencies. Implement the request; do not inspect other directories.",
          },
        });
        active = session;
        let timer,
          passed = false,
          failure = null;
        const started = Date.now();
        try {
          timer = setTimeout(() => {
            void session.interrupt().catch(() => {});
            void session.close();
          }, 120000);
          await session.open();
          const result = await session.run(task.prompt);
          if (result.status !== "completed")
            throw new Error("turn did not complete");
          const check = spawnSync(
            process.execPath,
            [
              "--input-type=module",
              "-e",
              `import assert from 'node:assert/strict';const target=${JSON.stringify(pathToFileURL(join(cwd, task.target)).href)};${task.check}`,
            ],
            { cwd, encoding: "utf8", timeout: 5000 },
          );
          passed = check.status === 0;
          if (!passed) failure = "independent acceptance check failed";
        } catch (error) {
          failure =
            session.controller?.context.clean(error.message, 300) ??
            "session failed";
        } finally {
          clearTimeout(timer);
          await session.close();
          active = null;
          const row = {
            task: task.id,
            repetition,
            policy,
            order: order.indexOf(policy),
            passed,
            failure,
            elapsedMs: Date.now() - started,
            metrics: measure(records),
            integrationEvents: records.filter((e) =>
              [
                "evaluation_failed",
                "update_failed",
                "update_unavailable",
                "update_unconfirmed",
                "checkpoint_failed",
              ].includes(e.type),
            ),
          };
          reports.push(row);
          await save();
          console.log(
            JSON.stringify({
              task: task.id,
              repetition,
              policy,
              passed,
              elapsedMs: row.elapsedMs,
            }),
          );
          await rm(cwd, { recursive: true, force: true });
        }
      }
    }
  }
} finally {
  process.off("SIGINT", stop);
  process.off("SIGTERM", stop);
  await save();
}
console.log(
  JSON.stringify({
    report: join(output, "report.json"),
    summary: report.summary,
  }),
);
if (
  !report.complete ||
  reports.some((r) => !r.passed || r.metrics.integrationFailures)
)
  process.exitCode = 1;
