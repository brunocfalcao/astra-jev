import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, access, readFile, stat } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Exercise real readline terminal rendering, without a service call or real key.
const driver = `
import { PassThrough } from "node:stream";
import { ensurePrivacy, setup } from ${JSON.stringify(new URL("../src/onboarding.mjs", import.meta.url).href)};
const report = process.stdout.write.bind(process.stdout);
const input = new PassThrough(), output = new PassThrough();
input.isTTY = output.isTTY = true;
input.setRawMode = () => {};
output.columns = 110;
Object.defineProperty(process, "stdin", { value: input });
Object.defineProperty(process, "stdout", { value: output });
let text = "", consentScreen = "", sent = false, keySent = false;
output.on("data", chunk => {
  text += chunk;
  if (!sent && text.includes("Allow this data flow")) {
    sent = true;
    setImmediate(() => {
      consentScreen = text;
      input.write(process.env.FIXTURE_ANSWER);
    });
  }
  if (!keySent && text.includes("TypeSafe API key (hidden; Enter skips):")) {
    keySent = true;
    setImmediate(() => input.write("fixture-secret-only\\n"));
  }
});
let error = null;
try {
  await (process.env.FIXTURE_SETUP === "1" ? setup() : ensurePrivacy());
} catch (e) { error = e.message; }
input.destroy();
report(JSON.stringify({ consentScreen, text, error }));
`;

async function runFixture(answer, setup = false) {
  const home = await mkdtemp(join(tmpdir(), "astra-onboarding-"));
  const env = { ...process.env, HOME: home, TERM: "xterm-256color" };
  delete env.ASTRA_JEV_PRIVACY_ACK;
  delete env.TYPESAFE_API_KEY;
  env.FIXTURE_ANSWER = answer;
  env.FIXTURE_SETUP = setup ? "1" : "0";
  const result = spawnSync(
    process.execPath,
    ["--input-type=module", "-e", driver],
    {
      env,
      encoding: "utf8",
      timeout: 5000,
    },
  );
  try {
    assert.equal(result.status, 0, result.stderr);
    return { home, ...JSON.parse(result.stdout), stderr: result.stderr };
  } catch (error) {
    await rm(home, { recursive: true, force: true });
    throw error;
  }
}

test("consent survives terminal redraw and explicitly explains YES and Enter", async () => {
  const result = await runFixture("YES\n");
  try {
    // Inspect the final rendered line, not a prompt subsequently erased by ANSI.
    const rendered = result.consentScreen.split("\x1b[0J").at(-1);
    assert.match(rendered, /Type YES.*Enter.*Enter alone cancels/);
    assert.equal(result.error, null);
    const path = join(result.home, ".config/astra-jev/privacy-v1.json");
    assert.deepEqual(JSON.parse(await readFile(path, "utf8")), {
      version: 1,
      acknowledged: true,
    });
    assert.equal((await stat(path)).mode & 0o777, 0o600);
  } finally {
    await rm(result.home, { recursive: true, force: true });
  }
});

test("blank, refusal and Ctrl-C never record consent; hidden key input stays hidden", async () => {
  for (const answer of ["\n", "no\n", "\x03"]) {
    const result = await runFixture(answer);
    try {
      assert.match(result.error, /cancelled/i);
      await assert.rejects(
        access(join(result.home, ".config/astra-jev/privacy-v1.json")),
        { code: "ENOENT" },
      );
      await assert.rejects(
        access(join(result.home, ".config/astra-jev/credentials")),
        { code: "ENOENT" },
      );
    } finally {
      await rm(result.home, { recursive: true, force: true });
    }
  }
  const result = await runFixture("y\n", true);
  try {
    assert.equal(result.error, null);
    assert.match(result.text, /TypeSafe API key \(hidden; Enter skips\):/);
    assert.equal(
      (result.text + result.stderr).includes("fixture-secret-only"),
      false,
    );
    const path = join(result.home, ".config/astra-jev/credentials");
    assert.equal(
      await readFile(path, "utf8"),
      "TYPESAFE_API_KEY=fixture-secret-only\n",
    );
    assert.equal((await stat(path)).mode & 0o777, 0o600);
  } finally {
    await rm(result.home, { recursive: true, force: true });
  }
});
