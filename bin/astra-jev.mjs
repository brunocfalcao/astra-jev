#!/usr/bin/env -S node --use-system-ca
import { mkdir, lstat, open } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { writeSync } from "node:fs";
import { projectConfig } from "../src/project-config.mjs";
import {
  planLaunch,
  runCodex,
  exitCode,
  snapshotDefaults,
} from "../src/codex-launch.mjs";
import { Jev, loadKey } from "../src/jev.mjs";
import { Session } from "../src/session.mjs";
import { NativeTui } from "../src/native-tui.mjs";
import { SessionHost, sessionSocket } from "../src/persistent.mjs";
import { redact } from "../src/context.mjs";
import { terminalSafe } from "../src/terminal.mjs";
import { ensurePrivacy } from "../src/onboarding.mjs";

const args = process.argv.slice(2);
let session, host, gateway, log, key;
const handlers = [];
try {
  const plan = planLaunch(args);
  const config = await projectConfig(plan.cwd);
  if (!config.enabled || plan.direct) {
    if (config.requireJev)
      throw new Error(
        `Jev is required; this invocation would run without Jev (${plan.reason ?? "disabled"}). No Codex process was started.`,
      );
    console.error(
      `Astra-Jev: Jev inactive (${config.enabled ? plan.reason : "disabled in astra-jev.json"}); forwarding arguments to stock Codex.`,
    );
    process.exitCode = exitCode(await runCodex([...snapshotDefaults, ...args]));
  } else {
    if (!process.stdin.isTTY)
      throw new Error(
        "Interactive Codex requires a terminal; use astra-jev exec for stock non-interactive execution",
      );
    if (!config.fixedEffort) {
      await ensurePrivacy();
      key = loadKey();
    }
    const directory = join(homedir(), ".local/share/astra-jev/logs");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const info = await lstat(directory);
    if (
      !info.isDirectory() ||
      info.uid !== process.getuid() ||
      info.mode & 0o077
    )
      throw new Error(
        "Decision log directory must be private and owned by this user",
      );
    const logPath = join(
      directory,
      `${new Date().toISOString().replaceAll(":", "-")}-${randomUUID()}.jsonl`,
    );
    log = await open(logPath, "wx", 0o600);
    const record = (event) => writeSync(log.fd, JSON.stringify(event) + "\n");
    const createSession = () =>
      new Session({
        cwd: plan.cwd,
        nativeUi: true,
        config: [...plan.config],
        fixedEffort: config.fixedEffort,
        requireJev: config.requireJev,
        resumePermissions: config.resumePermissions,
        jev: key ? new Jev({ key }) : null,
        secrets: key ? [key] : [],
        logPath,
        record,
      });
    session = createSession();
    await session.prepare({ resume: plan.resume });
    const name = `tui-${process.pid}`;
    host = new SessionHost({
      session,
      info: {},
      path: await sessionSocket(name),
      observerOnly: true,
    });
    await host.listen();
    gateway = new NativeTui({
      session,
      record,
      verbose: config.verbose,
      createFreshSession: createSession,
      onSessionChanged: (fresh) => {
        session = fresh;
        host.replaceSession(fresh);
      },
      onOpen: (info) => {
        host.info = info;
      },
    });
    await gateway.open();
    console.error(
      `Astra-Jev: ${config.fixedEffort ? `FIXED ${config.fixedEffort} effort; Jev inactive` : plan.resume ? "RESUME PICKER: Enter resumes with per-turn Jev; Esc starts fresh" : "ADAPTIVE Jev checkpoints"}.\n${plan.resume ? `Resume permissions: ${config.resumePermissions}.\n` : ""}Require Jev: ${config.requireJev ? "on" : "off"}\nDecision log: ${logPath}\nLive evidence: astra-jev-control --status ${name}\nWrapper settings: ${join(plan.cwd, "astra-jev.json")}`,
    );
    for (const signal of ["SIGINT", "SIGTERM"]) {
      const handler = () => {
        void gateway
          .close()
          .then(() => host.close())
          .catch(() => {});
      };
      process.on(signal, handler);
      handlers.push([signal, handler]);
    }
    process.exitCode = exitCode(
      await gateway.launch({
        codexArgs: args,
        defaults: plan.defaults,
        noAltScreen: config.noAltScreen,
      }),
    );
  }
} catch (error) {
  console.error(terminalSafe(redact(error.message, key ? [key] : [])));
  process.exitCode = 1;
} finally {
  for (const [signal, handler] of handlers) process.off(signal, handler);
  await gateway?.close();
  if (host) await host.close();
  else await session?.close();
  await log?.close();
}
