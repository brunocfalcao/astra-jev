import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  writeFile,
  rm,
  realpath,
  symlink,
} from "node:fs/promises";
import { spawnSync } from "node:child_process";
import {
  projectTotals,
  projectTable,
  measuredComparisons,
} from "../src/project-status.mjs";

const generation = (id, input = 100) => ({
  type: "generation_completed",
  threadId: "t",
  responseId: id,
  usage: { inputTokens: input, cachedInputTokens: 20, outputTokens: 10 },
});
async function fixture(run) {
  const dir = await mkdtemp("/tmp/astra-project-table-");
  try {
    const project = await realpath(dir);
    const logs = `${dir}/logs`;
    await mkdir(logs, { mode: 0o700 });
    await run({
      dir,
      project,
      logs,
      write: async (name, events) =>
        writeFile(
          `${logs}/2026-${name}.jsonl`,
          events.map((e) => JSON.stringify(e)).join("\n") + "\n",
          { mode: 0o600 },
        ),
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
const opened = (project, policy = "auto", mode = "adaptive-checkpoint") => ({
  type: "session_opened",
  projectCwd: project,
  threadId: "t",
  policy,
  mode,
});

test("project totals span full logs and launches, deduplicate responses and exclude other folders", async () =>
  fixture(async ({ dir, project, logs, write }) => {
    assert.equal(
      (await projectTotals(project, logs)).groups.adaptive.sessions.size,
      0,
    );
    await write("one", [
      opened(project),
      generation("a"),
      {
        type: "jev_evaluation",
        attempts: 1,
        success: true,
        elapsedMs: 20,
        usage: { input_tokens: 5, output_tokens: 2 },
      },
      { type: "padding", value: "x".repeat(1100000) },
      generation("a"),
    ]);
    await write("two", [opened(project), generation("b", 200)]);
    await write("three", [
      opened(project, "high", "fixed"),
      generation("c", 300),
    ]);
    await write("foreign", [opened(project + "/other"), generation("d", 900)]);
    await write("legacy", [
      { type: "session_opened", threadId: "old" },
      generation("old", 999),
    ]);
    const totals = await projectTotals(project, logs),
      a = totals.groups.adaptive.status.snapshot();
    assert.equal(a.inputTokens, 300);
    assert.equal(a.outputTokens, 20);
    assert.equal(a.jevInputTokens, 5);
    assert.equal(a.jevOutputTokens, 2);
    assert.equal(totals.groups.adaptive.sessions.size, 2);
    assert.equal(totals.groups.fixed.status.snapshot().inputTokens, 300);
    assert.equal(totals.unattributed, 1);
    await symlink(project, `${dir}/alias`);
    assert.equal(
      (
        await projectTotals(`${dir}/alias`, logs)
      ).groups.adaptive.status.snapshot().inputTokens,
      300,
    );
    assert.match(
      projectTable(totals).join("\n"),
      /Project-work savings: unavailable/,
    );
  }));

test("resumed fixed sessions, active turns, missing usage and mode changes remain incomplete", async () =>
  fixture(async ({ project, logs, write }) => {
    await write("resume", [
      { ...opened(project, "high", "fixed"), captureAvailable: false },
      { type: "turn_preparing" },
      { type: "turn_completed" },
    ]);
    await write("active", [
      opened(project),
      { type: "turn_preparing" },
      generation("a"),
    ]);
    await write("switch", [
      opened(project),
      { type: "model_changed", mode: "inactive" },
      { type: "turn_preparing" },
      { type: "turn_completed" },
    ]);
    const result = await projectTotals(project, logs);
    assert.equal(result.groups.fixed.incomplete, true);
    assert.equal(result.groups.adaptive.incomplete, true);
    assert.equal(result.groups.inactive.incomplete, true);
    assert.match(projectTable(result).join("\n"), /Incomplete/);
  }));

test("only complete paired measured project reports produce differences with Jev overhead", async () =>
  fixture(async ({ project }) => {
    const root = `${project}/verification/benchmark-123`;
    await mkdir(root, { recursive: true });
    const row = (policy) => ({
      task: "a",
      repetition: 0,
      policy,
      passed: true,
      metrics: {
        integrationFailures: 0,
        astra: { input: 100, cached: 20, output: 10, complete: true },
        jev: {
          input: policy === "adaptive" ? 5 : 0,
          output: policy === "adaptive" ? 2 : 0,
          complete: true,
        },
      },
    });
    const r = {
      projectCwd: project,
      comparisonVersion: 1,
      complete: true,
      reports: [row("adaptive"), row("fixed-high")],
    };
    const save = () => writeFile(`${root}/report.json`, JSON.stringify(r));
    assert.deepEqual(await measuredComparisons(project), []);
    await save();
    assert.match(
      (await measuredComparisons(project)).join("\n"),
      /Token difference: -7/,
    );
    r.reports[0].metrics.jev.complete = false;
    await save();
    assert.deepEqual(await measuredComparisons(project), []);
    r.reports[0].metrics.jev.complete = true;
    r.reports.pop();
    await save();
    assert.deepEqual(await measuredComparisons(project), []);
    r.reports.push(row("fixed-high"));
    r.projectCwd += "/other";
    await save();
    assert.deepEqual(await measuredComparisons(project), []);
  }));

test("status --table uses the shell folder, never CODEX_THREAD_ID or provider credentials", async () =>
  fixture(async ({ dir, project }) => {
    const cli = new URL("../bin/astra-jev-control.mjs", import.meta.url)
      .pathname;
    const r = spawnSync(process.execPath, [cli, "status", "--table"], {
      cwd: project,
      env: {
        ...process.env,
        HOME: dir,
        CODEX_THREAD_ID: "unrelated",
        TYPESAFE_API_KEY: "",
      },
      encoding: "utf8",
    });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, new RegExp(`Project: ${project}`));
    assert.match(r.stdout, /No records/);
    assert.equal(r.stdout.includes("Allow this data flow"), false);
  }));
