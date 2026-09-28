import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { Session } from "../src/session.mjs";
import { Jev, loadKey } from "../src/jev.mjs";

const key = loadKey();
const config = [
  "project_doc_max_bytes=0",
  "features.apps=false",
  "features.plugins=false",
];
for (const m of readFileSync(
  join(homedir(), ".codex/config.toml"),
  "utf8",
).matchAll(/^\[mcp_servers\.([\w-]+)\]/gm))
  config.push(`mcp_servers.${m[1]}.enabled=false`);
const cases = [
  {
    id: "routine",
    fixture: {
      project: "Fixture",
      version: "1.2.3",
      request: 'Return only JSON {"project": project, "version": version}.',
    },
    expected: { project: "Fixture", version: "1.2.3" },
  },
  {
    id: "compatibility",
    fixture: {
      constraints: [
        "Runtime core must stay at 8 and API at 3.",
        "Only stable analyzer releases may be installed.",
        "Existing unrelated lock edits must remain intact.",
      ],
      candidates: {
        stable_in_process:
          "Analyzer 2 requires core 7 and API 2 in the application dependency graph.",
        preview_in_process:
          "Analyzer 3-dev supports core 8 and API 3, but is not stable.",
        forced_override:
          "Install analyzer 2 in process with ignored requirements, keeping core 8 and API 3.",
        isolated_stable:
          "Run stable analyzer 2 in a separate tool environment with core 7 and API 2; read application source without changing its dependencies or lock.",
      },
      request:
        "Choose the only compatible plan under all constraints. Return JSON with plan (candidate key), runtime_changes (boolean), rewrite_unrelated_lock_entries (boolean). Do not execute a plan.",
    },
    expected: {
      plan: "isolated_stable",
      runtime_changes: false,
      rewrite_unrelated_lock_entries: false,
    },
  },
];
const reports = [];
for (const task of cases) {
  const cwd = mkdtempSync(join(tmpdir(), "astra-jev-matched-"));
  writeFileSync(join(cwd, "task.json"), JSON.stringify(task.fixture, null, 2));
  for (const policy of ["adaptive", "fixed-high"]) {
    const records = [];
    const session = new Session({
      cwd,
      config: [...config],
      jev: new Jev({ key }),
      secrets: [key],
      fixedEffort: policy === "fixed-high" ? "high" : null,
      record: (e) => records.push(e),
      threadOptions: {
        sandbox: "read-only",
        approvalPolicy: "never",
        developerInstructions:
          "Synthetic local comparison. Read only task.json once with a native shell tool, then answer its request. No other tools, changes, or delegation. Return JSON without Markdown.",
      },
    });
    let finalText = "";
    session.transport.on("notification", ({ method, params }) => {
      const item = params?.item;
      if (
        method === "rawResponseItem/completed" &&
        params.threadId === session.threadId &&
        item?.type === "message" &&
        item.role === "assistant" &&
        item.phase === "final_answer"
      )
        finalText += (item.content ?? [])
          .filter((x) => x.type === "output_text")
          .map((x) => x.text)
          .join("");
    });
    let timer;
    const started = Date.now();
    try {
      const info = await session.open();
      timer = setTimeout(() => {
        void session.interrupt().catch(() => session.close());
      }, 90000);
      const result = await session.run(
        "Read task.json and answer its request. Do not inspect other files.",
      );
      assert.equal(result.status, "completed");
      const output = JSON.parse(finalText.trim());
      assert.deepEqual(output, task.expected);
      const generations = records.filter(
        (e) => e.type === "generation_completed",
      );
      assert.ok(generations.length >= 2);
      let effortEvidence = "native generation captures";
      if (policy === "adaptive")
        assert.ok(generations.every((e) => e.verified));
      else {
        // A fixed turn need not emit a redundant configuration_update. Verify
        // its native persisted turn context; do not label it a step capture.
        const contexts = readFileSync(info.threadPath, "utf8")
          .trim()
          .split("\n")
          .map(JSON.parse)
          .filter((e) => e.type === "turn_context");
        assert.equal(contexts.at(-1).payload.effort, "high");
        assert.equal(contexts.at(-1).payload.model, "gpt-6-astra");
        assert.equal(
          records.filter((e) => e.type === "update_published").length,
          0,
        );
        effortEvidence =
          "native turn context with fixed HIGH; no adaptive updates";
      }
      const failures = records.filter((e) =>
        [
          "evaluation_failed",
          "update_failed",
          ...(policy === "adaptive" ? ["update_unconfirmed"] : []),
          "checkpoint_failed",
        ].includes(e.type),
      );
      assert.equal(failures.length, 0);
      const report = {
        task: task.id,
        policy,
        passed: true,
        threadId: info.threadId,
        elapsedMs: Date.now() - started,
        output,
        efforts: generations.map((e) => e.effort),
        fixedEffort: policy === "fixed-high" ? "high" : null,
        effortEvidence,
        unconfirmedStepCaptures: records.filter(
          (e) => e.type === "update_unconfirmed",
        ).length,
        decisions: records.filter((e) => e.type === "decision_selected"),
        tokens: generations.reduce(
          (total, e) => ({
            input: total.input + e.usage.inputTokens,
            cached: total.cached + e.usage.cachedInputTokens,
            output: total.output + e.usage.outputTokens,
          }),
          { input: 0, cached: 0, output: 0 },
        ),
      };
      reports.push(report);
      console.log(
        JSON.stringify({
          task: task.id,
          policy,
          passed: true,
          efforts: report.efforts,
        }),
      );
    } finally {
      clearTimeout(timer);
      await session.close();
    }
  }
}
writeFileSync(
  new URL("../verification/effort-comparison.json", import.meta.url),
  JSON.stringify(
    {
      date: new Date().toISOString(),
      scope:
        "Two synthetic read-only tasks, adaptive versus fixed HIGH; exact output checks. Small smoke comparison, not a quality or cost benchmark.",
      reports,
    },
    null,
    2,
  ) + "\n",
);
