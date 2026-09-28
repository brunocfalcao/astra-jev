import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

const cli = fileURLToPath(
  new URL("../bin/astra-jev-control.mjs", import.meta.url),
);
const cwd = mkdtempSync("/tmp/astra-jev-cli-proof-");
writeFileSync(
  join(cwd, "sample.txt"),
  "Synthetic reconnect fixture. Value: 42.",
);
const name = `proof-${process.pid}`;
const host = spawn(
  process.execPath,
  ["--use-system-ca", cli, "--serve", name, "--read-only", "--cwd", cwd],
  { stdio: ["ignore", "pipe", "pipe"] },
);
let stderr = "",
  timer;
const exited = new Promise((resolve) =>
  host.once("exit", (code, signal) => resolve({ code, signal })),
);
const ready = new Promise((resolve, reject) => {
  host.on("error", reject);
  host.stderr.on("data", (data) => {
    stderr += data;
    if (stderr.includes(`Session ${name} ready.`)) resolve();
  });
  host.once("exit", (code) =>
    reject(new Error(`Host exited before ready: ${code}`)),
  );
  timer = setTimeout(() => reject(new Error("Host startup timed out")), 30000);
});
async function cliRun(args) {
  const child = spawn(process.execPath, ["--use-system-ca", cli, ...args], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "",
    errors = "";
  child.stdout.on("data", (chunk) => {
    output += chunk;
  });
  child.stderr.on("data", (chunk) => {
    errors += chunk;
  });
  const timeout = setTimeout(() => child.kill("SIGTERM"), 90000);
  const code = await new Promise((resolve, reject) => {
    child.once("exit", resolve);
    child.once("error", reject);
  });
  clearTimeout(timeout);
  assert.equal(code, 0, errors.slice(-1000));
  return { output, threadId: errors.match(/Thread: ([^\n]+)/)?.[1] };
}
try {
  await ready;
  clearTimeout(timer);
  const initialStatus = await cliRun(["--status", name]);
  assert.ok(initialStatus.output.includes("live host"));
  assert.ok(initialStatus.output.includes("Jev: not checked"));
  const first = await cliRun([
    "--attach",
    name,
    "Read sample.txt with one native shell read, then reply exactly FIRST_OK.",
  ]);
  assert.ok(first.output.includes("FIRST_OK"));
  const second = await cliRun([
    "--attach",
    name,
    "Read sample.txt again with one native shell read, then reply exactly SECOND_OK.",
  ]);
  assert.ok(second.output.includes("SECOND_OK"));
  assert.equal(first.threadId, second.threadId);
  const liveStatus = await cliRun(["--status", name]);
  assert.ok(liveStatus.output.includes("Jev: responding"));
  assert.ok(liveStatus.output.includes(first.threadId));
  await cliRun(["--stop", name]);
  const exit = await exited;
  assert.equal(exit.code, 0);
  const logPath = stderr.match(/Decision log: ([^\n]+)/)?.[1];
  const records = readFileSync(logPath, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.equal(records.filter((x) => x.type === "session_opened").length, 1);
  const turns = records.filter((x) => x.type === "turn_completed");
  assert.equal(turns.length, 2);
  assert.ok(turns.every((x) => x.generations >= 2));
  assert.ok(
    records.filter((x) => x.type === "checkpoint_released").length >= 2,
  );
  const result = {
    passed: true,
    first,
    second,
    turns,
    checkpoints: records.filter((x) => x.type === "checkpoint_released"),
    exit,
    logPath,
    statusQueryVerified: true,
  };
  writeFileSync(
    new URL("../verification/persistent-cli.json", import.meta.url),
    JSON.stringify(result, null, 2),
    { mode: 0o600 },
  );
  console.log(
    JSON.stringify({
      passed: true,
      threadId: first.threadId,
      turns: turns.length,
      generationCounts: turns.map((x) => x.generations),
      checkpoints: result.checkpoints.length,
      hostExit: exit.code,
    }),
  );
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  clearTimeout(timer);
  if (host.exitCode === null && host.signalCode === null) {
    host.kill("SIGTERM");
    await exited;
  }
}
