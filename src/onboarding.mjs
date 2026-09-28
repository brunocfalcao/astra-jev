import { mkdir, lstat, open, readFile, rename, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { Writable } from "node:stream";
import { loadKey } from "./jev.mjs";

export const privacyNotice =
  "Jev sends bounded task prompts, public assistant notes and recent tool excerpts to TypeSafe to choose Astra effort. Known secrets are redacted best-effort; arbitrary sensitive text may remain. Hidden reasoning and image bytes are excluded. Codex retains its own history. TypeSafe usage may be billed separately. See PRIVACY.md before using confidential projects.";
export const settingsDirectory = () => join(homedir(), ".config/astra-jev");

async function privateDirectory(directory) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const info = await lstat(directory);
  if (!info.isDirectory() || info.uid !== process.getuid() || info.mode & 0o077)
    throw new Error(
      "Astra-Jev settings directory must be private and owned by this user",
    );
}
export async function acknowledgePrivacy(directory = settingsDirectory()) {
  await privateDirectory(directory);
  const path = join(directory, "privacy-v1.json");
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.uid !== process.getuid() || info.mode & 0o077)
      throw new Error(
        "Privacy acknowledgment must be a private file owned by this user",
      );
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const temporary = join(directory, `.privacy-${randomUUID()}.tmp`);
  let file;
  try {
    file = await open(temporary, "wx", 0o600);
    await file.writeFile('{"version":1,"acknowledged":true}\n');
    await file.close();
    file = undefined;
    await rename(temporary, path);
  } finally {
    await file?.close();
    await rm(temporary, { force: true });
  }
}
export async function privacyAcknowledged({
  env = process.env,
  directory = settingsDirectory(),
} = {}) {
  if (env.ASTRA_JEV_PRIVACY_ACK === "1") return true;
  try {
    const info = await lstat(join(directory, "privacy-v1.json"));
    if (!info.isFile() || info.uid !== process.getuid() || info.mode & 0o077)
      return false;
    const data = JSON.parse(
      await readFile(join(directory, "privacy-v1.json"), "utf8"),
    );
    return data.version === 1 && data.acknowledged === true;
  } catch {
    return false;
  }
}
function ask(prompt, { secret = false } = {}) {
  if (!process.stdin.isTTY || !process.stdout.isTTY)
    throw new Error(
      "Run astra-jev-control setup in an interactive terminal. Automation can acknowledge the documented data flow with ASTRA_JEV_PRIVACY_ACK=1.",
    );
  const muted = new Writable({
    write(_chunk, _encoding, done) {
      done();
    },
  });
  const rl = createInterface({
    input: process.stdin,
    output: secret ? muted : process.stdout,
    terminal: true,
  });
  process.stdout.write(prompt);
  return new Promise((resolve, reject) => {
    let answered = false;
    rl.once("SIGINT", () => {
      rl.close();
    });
    rl.once("close", () => {
      if (!answered) reject(new Error("Setup cancelled"));
    });
    rl.question("", (answer) => {
      answered = true;
      rl.close();
      if (secret) process.stdout.write("\n");
      resolve(answer);
    });
  });
}
export async function ensurePrivacy() {
  if (await privacyAcknowledged()) return;
  console.error(privacyNotice);
  const answer = await ask(
    "Allow this data flow for Jev sessions on this account? [y/N] ",
  );
  if (!/^y(?:es)?$/i.test(answer.trim()))
    throw new Error("Jev setup cancelled; no evaluator request was sent");
  await acknowledgePrivacy();
}
export async function setup() {
  await ensurePrivacy();
  try {
    loadKey();
    console.log(
      "A Jev key is available. Its value was not displayed or changed.",
    );
  } catch {
    const key = (
      await ask("TypeSafe API key (hidden; Enter skips): ", { secret: true })
    ).trim();
    if (key) {
      if (!/^[A-Za-z0-9._-]+$/.test(key))
        throw new Error("Unexpected API key format; no key was stored");
      const directory = settingsDirectory();
      await privateDirectory(directory);
      const file = await open(join(directory, "credentials"), "wx", 0o600);
      try {
        await file.writeFile(`TYPESAFE_API_KEY=${key}\n`);
      } finally {
        await file.close();
      }
      console.log("Key stored in the private Astra-Jev credential file.");
    } else
      console.log(
        "No key stored. Set TYPESAFE_API_KEY before an adaptive session.",
      );
  }
  console.log(
    "Next: astra-jev-control doctor, then astra-jev in a project folder.",
  );
}
