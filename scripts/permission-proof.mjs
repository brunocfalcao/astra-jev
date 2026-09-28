import assert from "node:assert/strict";
import { mkdtempSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Session } from "../src/session.mjs";

const cwd = mkdtempSync("/tmp/astra-jev-permission-proof-");
const path = join(cwd, "denied.txt");
const commands = [];
const codeModeResults = [];
const session = new Session({
  cwd,
  fixedEffort: "low",
  threadOptions: { sandbox: "read-only", approvalPolicy: "never" },
});
session.transport.on("notification", ({ method, params }) => {
  if (method === "item/completed" && params.item?.type === "commandExecution")
    commands.push({
      status: params.item.status,
      exitCode: params.item.exitCode,
    });
  if (
    method === "rawResponseItem/completed" &&
    params.item?.type === "custom_tool_call_output"
  ) {
    for (const part of params.item.output ?? []) {
      if (part.type !== "input_text") continue;
      try {
        const result = JSON.parse(part.text);
        if (Number.isInteger(result.exit_code))
          codeModeResults.push({
            exitCode: result.exit_code,
            permissionDenied:
              /Operation not permitted|Permission denied|Read-only file system/.test(
                result.output ?? "",
              ),
          });
      } catch {}
    }
  }
});
let result = { passed: false };
try {
  await session.open();
  assert.equal(session.status().sandbox, "readOnly");
  const turn = await session.run(
    "Verify the read-only sandbox with a negative test: attempt once, using one native shell command, to create denied.txt in the current directory. Expected result is permission denial. Do not retry, request broader permissions, or use a workaround. Report the result.",
  );
  result = {
    passed: false,
    threadId: session.threadId,
    nativeSandbox: session.status().sandbox,
    nativeCommands: commands,
    codeModeResults,
    fileCreated: existsSync(path),
    output: turn.text,
  };
  assert.equal(turn.status, "completed");
  assert.ok(
    commands.some(
      (x) =>
        ["failed", "declined"].includes(x.status) ||
        (Number.isInteger(x.exitCode) && x.exitCode !== 0),
    ) || codeModeResults.some((x) => x.exitCode !== 0 && x.permissionDenied),
    "Native command must actually fail",
  );
  assert.equal(
    existsSync(path),
    false,
    "Read-only sandbox must prevent creation",
  );
  result.passed = true;
} finally {
  await session.close();
  writeFileSync(
    new URL("../verification/permissions.json", import.meta.url),
    JSON.stringify(result, null, 2),
    { mode: 0o600 },
  );
  console.log(JSON.stringify(result));
}
