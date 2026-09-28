import { createReadStream } from "node:fs";
import { readdir, lstat, realpath, readFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import { join } from "node:path";
import { homedir } from "node:os";
import { Status } from "./status.mjs";

const validCount = (n) => Number.isSafeInteger(n) && n >= 0;
const bucket = () => ({
  sessions: new Set(),
  status: new Status(),
  incomplete: false,
  generations: new Set(),
});
export async function projectTotals(
  cwd,
  directory = join(homedir(), ".local/share/astra-jev/logs"),
) {
  const project = await realpath(cwd);
  const groups = { adaptive: bucket(), fixed: bucket(), inactive: bucket() };
  let unattributed = 0;
  let info;
  try {
    info = await lstat(directory);
  } catch (e) {
    if (e.code === "ENOENT") return { project, groups, unattributed };
    throw e;
  }
  if (!info.isDirectory() || info.uid !== process.getuid() || info.mode & 0o077)
    throw new Error(
      "Decision log directory must be private and owned by this user",
    );
  for (const name of await readdir(directory)) {
    if (!/^\d{4}-.*\.jsonl$/.test(name)) continue;
    const path = join(directory, name),
      stat = await lstat(path);
    if (!stat.isFile() || stat.uid !== process.getuid() || stat.mode & 0o077)
      continue;
    let matched = false,
      attributed = false,
      group,
      mode,
      policy,
      active = false,
      captureAvailable = true;
    const input = createReadStream(path, { end: Math.max(0, stat.size - 1) });
    const lines = createInterface({ input, crlfDelay: Infinity });
    try {
      for await (const line of lines) {
        let e;
        try {
          e = JSON.parse(line);
        } catch {
          if (group) group.incomplete = true;
          continue;
        }
        if (!e || typeof e !== "object" || Array.isArray(e)) {
          if (group) group.incomplete = true;
          continue;
        }
        if (e.type === "session_opened") {
          attributed = typeof e.projectCwd === "string";
          matched = e.projectCwd === project;
          mode = e.mode;
          policy = e.policy ?? "auto";
          captureAvailable = e.captureAvailable !== false;
        }
        if (!matched) continue;
        if (e.type === "model_changed") mode = e.mode;
        if (e.type === "policy_changed") policy = e.policy;
        group =
          groups[
            mode === "inactive"
              ? "inactive"
              : policy === "auto"
                ? "adaptive"
                : "fixed"
          ];
        group.sessions.add(name);
        if (e.type === "turn_preparing") {
          active = true;
          if (
            !captureAvailable ||
            mode === "inactive" ||
            mode?.includes("resume")
          )
            group.incomplete = true;
        }
        if (e.type === "turn_completed" || e.type === "turn_interrupted")
          active = false;
        if (e.type === "generation_completed") {
          const id = e.responseId ? `${e.threadId}:${e.responseId}` : null;
          if (id && group.generations.has(id)) continue;
          if (id) group.generations.add(id);
          if (
            ![
              e.usage?.inputTokens,
              e.usage?.cachedInputTokens,
              e.usage?.outputTokens,
            ].every(validCount)
          ) {
            group.incomplete = true;
            continue;
          }
        }
        group.status.update(e);
      }
    } finally {
      lines.close();
      input.destroy();
    }
    if (active && group) group.incomplete = true;
    if (!attributed) unattributed++;
  }
  for (const group of Object.values(groups)) {
    const s = group.status.snapshot();
    if (
      s.jevUnknownUsage ||
      s.jevUnknownAttempts ||
      (s.evaluations && !s.jevAccounting)
    )
      group.incomplete = true;
  }
  return { project, groups, unattributed };
}

function render(rows) {
  const widths = rows[0].map((_, i) =>
    Math.max(...rows.map((r) => String(r[i]).length)),
  );
  return rows.map((r) =>
    r.map((v, i) => String(v).padEnd(widths[i])).join(" | "),
  );
}
export function projectTable(result) {
  const rows = [
    ["Recorded project usage", "Adaptive Jev", "Fixed effort", "Other models"],
  ];
  const groups = Object.values(result.groups),
    states = groups.map((g) => g.status.snapshot());
  const add = (name, fn) =>
    rows.push([name, ...states.map((s, i) => fn(s, groups[i]))]);
  add("Sessions", (_, g) => g.sessions.size);
  add("Astra input", (s) => s.inputTokens);
  add("Cached input (included)", (s) => s.cachedInputTokens);
  add("Astra output", (s) => s.outputTokens);
  add("Jev input", (s) => s.jevInputTokens);
  add("Jev output", (s) => s.jevOutputTokens);
  add(
    "Combined tokens",
    (s) =>
      s.inputTokens + s.outputTokens + s.jevInputTokens + s.jevOutputTokens,
  );
  add("Jev evaluations", (s) => s.jevRequests);
  add("Jev time (ms)", (s) => s.jevElapsedMs);
  add("Coverage", (_, g) =>
    !g.sessions.size ? "No records" : g.incomplete ? "Incomplete" : "Recorded",
  );
  return [
    `Project: ${result.project}`,
    "Cumulative recorded usage across launches; active turns may be incomplete.",
    ...render(rows),
    "Project-work savings: unavailable from ordinary sessions; different work is not a baseline.",
    `${result.unattributed} older log(s) lack project attribution and are excluded.`,
    "Resumed/other-model tokens are unavailable; incomplete totals are lower bounds.",
  ];
}

export async function measuredComparisons(cwd) {
  const project = await realpath(cwd),
    directory = join(project, "verification");
  let names;
  try {
    names = await readdir(directory);
  } catch (e) {
    if (e.code === "ENOENT") return [];
    throw e;
  }
  for (const name of names
    .filter((n) => /^benchmark-\d+$/.test(n))
    .sort()
    .reverse()) {
    let report;
    try {
      report = JSON.parse(
        await readFile(join(directory, name, "report.json"), "utf8"),
      );
    } catch {
      continue;
    }
    if (
      report.projectCwd !== project ||
      report.comparisonVersion !== 1 ||
      !report.complete ||
      !Array.isArray(report.reports)
    )
      continue;
    const pairs = new Map();
    let valid = true;
    for (const r of report.reports) {
      const a = r.metrics?.astra,
        j = r.metrics?.jev;
      if (
        !["adaptive", "fixed-high"].includes(r.policy) ||
        !r.passed ||
        r.metrics?.integrationFailures !== 0 ||
        !a?.complete ||
        !j?.complete ||
        ![a.input, a.cached, a.output, j.input, j.output].every(validCount)
      ) {
        valid = false;
        break;
      }
      const key = JSON.stringify([r.task, r.repetition]);
      const pair = pairs.get(key) ?? {};
      if (pair[r.policy] !== undefined) {
        valid = false;
        break;
      }
      pair[r.policy] = a.input + a.output + j.input + j.output;
      pairs.set(key, pair);
    }
    if (
      !valid ||
      !pairs.size ||
      [...pairs.values()].some(
        (p) => p.adaptive === undefined || p["fixed-high"] === undefined,
      )
    )
      continue;
    const adaptive = [...pairs.values()].reduce((n, p) => n + p.adaptive, 0),
      fixed = [...pairs.values()].reduce((n, p) => n + p["fixed-high"], 0);
    return [
      "",
      `Measured comparison: ${name} (${pairs.size} equivalent synthetic task pairs)`,
      ...render([
        ["Matched work", "Without Jev: fixed HIGH", "With adaptive Jev"],
        ["Combined tokens", fixed, adaptive],
      ]),
      `Token difference: ${fixed - adaptive} (${fixed ? (((fixed - adaptive) / fixed) * 100).toFixed(1) + "%" : "percentage unavailable"}); Jev overhead included.`,
      "Benchmark workload only; not savings for your project work. Cache usage may differ; tokens are not dollars.",
    ];
  }
  return [];
}
