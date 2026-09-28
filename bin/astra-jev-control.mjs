#!/usr/bin/env -S node --use-system-ca
import {
  writeSync,
  openSync,
  closeSync,
  mkdirSync,
  lstatSync,
  statSync,
} from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { Jev, loadKey } from "../src/jev.mjs";
import { Session } from "../src/session.mjs";
import { AppServer } from "../src/app-server.mjs";
import { redact } from "../src/context.mjs";
import { Terminal, terminalSafe, eventMessage } from "../src/terminal.mjs";
import { latestStatus, statusLines } from "../src/status.mjs";
import { ensurePrivacy, setup } from "../src/onboarding.mjs";
import {
  SessionHost,
  SessionClient,
  sessionSocket,
} from "../src/persistent.mjs";

const args = process.argv.slice(2),
  options = { cwd: process.cwd(), images: [] },
  words = [];
let session, terminal, key, host, logFd, nativeTui;
function usage() {
  console.log(
    "Usage: astra-jev-control [--cwd DIR] [--resume THREAD_ID] [--read-only] [--fixed-effort LEVEL] [--image PATH] [PROMPT]\n       astra-jev-control --tui [--cwd DIR] [--read-only] [PROMPT]\n       astra-jev-control --serve NAME [--cwd DIR] [--read-only]\n       astra-jev-control --attach NAME [--image PATH] [PROMPT]\n       astra-jev-control --status NAME\n       astra-jev-control --stop NAME\n       astra-jev-control status\n       astra-jev-control doctor\n       astra-jev-control setup\n\nWithout PROMPT, opens a terminal conversation. /help lists controls. Ctrl-C interrupts.\n--tui opens the stock Codex interface with Jev control; startup prints its live-status command.\n--serve keeps the native session alive in the foreground until stopped.\nstatus reads recent local evidence; --status queries a live named host. Neither calls Jev.\nExperimental: synchronous checkpoints cover supported local tools. Restarted threads use Jev per turn.",
  );
}
try {
  if (args.length === 1 && args[0] === "setup") {
    await setup();
    process.exit(0);
  }
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (["--help", "-h"].includes(arg)) {
      usage();
      process.exit(0);
    }
    if (
      [
        "--cwd",
        "--resume",
        "--fixed-effort",
        "--serve",
        "--attach",
        "--stop",
        "--status",
        "--image",
      ].includes(arg)
    ) {
      if (!args[i + 1] || args[i + 1].startsWith("--"))
        throw new Error(`${arg} needs a value`);
      if (arg === "--image") {
        options.images.push(args[++i]);
        continue;
      }
      options[
        {
          "--cwd": "cwd",
          "--resume": "resume",
          "--fixed-effort": "fixedEffort",
          "--serve": "serve",
          "--attach": "attach",
          "--stop": "stop",
          "--status": "status",
        }[arg]
      ] = args[++i];
    } else if (arg === "--read-only") options.readOnly = true;
    else if (arg === "--tui") options.tui = true;
    else if (arg.startsWith("-")) throw new Error(`Unknown option: ${arg}`);
    else words.push(arg);
  }
  options.cwd = resolve(options.cwd);
  if (
    options.tui &&
    (options.serve ||
      options.attach ||
      options.stop ||
      options.status ||
      options.images.length)
  )
    throw new Error(
      "--tui opens its own native session; attach images in the native composer",
    );
  options.images = options.images.map((path) => resolve(options.cwd, path));
  if (
    [options.serve, options.attach, options.stop, options.status].filter(
      Boolean,
    ).length > 1
  )
    throw new Error("Choose only one of --serve, --attach, --status or --stop");
  if (
    (options.attach || options.stop) &&
    args.some((x) =>
      ["--cwd", "--resume", "--fixed-effort", "--read-only"].includes(x),
    )
  )
    throw new Error(
      "Attached sessions retain the host configuration; set these options when starting --serve",
    );
  if (
    (options.serve || options.stop || options.status) &&
    (words.length || options.images.length)
  )
    throw new Error("Send prompts using --attach");
  const recordedStatus =
    words.length === 1 && words[0] === "status" && !options.attach;
  if (
    !options.fixedEffort &&
    !options.attach &&
    !options.stop &&
    !options.status &&
    !recordedStatus
  ) {
    await ensurePrivacy();
    key = loadKey();
  }
  const safe = (s) => terminalSafe(redact(s, key ? [key] : []));
  if (recordedStatus)
    console.log(
      statusLines(await latestStatus())
        .map(safe)
        .join("\n"),
    );
  else if (options.stop || options.status) {
    const client = new SessionClient({
      path: await sessionSocket(options.stop ?? options.status),
    });
    try {
      await client.connect();
      if (options.stop) {
        await client.request("stop");
        console.log(`Stopped session ${options.stop}.`);
      } else
        console.log(
          statusLines(await client.status())
            .map(safe)
            .join("\n"),
        );
    } finally {
      await client.close();
    }
  } else if (words[0] === "doctor") {
    const server = new AppServer({
      cwd: options.cwd,
      secrets: key ? [key] : [],
    });
    try {
      const initialized = await server.connect();
      const models = await server.request("model/list", {
        includeHidden: true,
      });
      const astra = models.data.find(
        (x) => x.model === "gpt-6-astra" || x.id === "gpt-6-astra",
      );
      if (!astra) throw new Error("Astra unavailable");
      const account = await server.request("account/read", {});
      const result = key
        ? await new Jev({ key }).decide({
            model: "gpt-6-astra",
            supportedEfforts: astra.supportedReasoningEfforts.map(
              (x) => x.reasoningEffort,
            ),
            latestUserPrompt: "Synthetic health check: report the word READY.",
          })
        : null;
      console.log(
        JSON.stringify(
          {
            astraAvailable: true,
            shellSnapshots: "disabled for this utility",
            checkpointVersionCompatible: /^astra_jev\/0\.157\.1(?:\s|$)/.test(
              initialized.userAgent ?? "",
            ),
            authentication: account.account?.type ?? "unknown",
            jevVerified: !!result,
            jevModel: result?.evaluatedModel,
            jevLatencyMs: result?.latencyMs,
            efforts: astra.supportedReasoningEfforts.map(
              (x) => x.reasoningEffort,
            ),
          },
          null,
          2,
        ),
      );
    } finally {
      await server.close();
    }
  } else {
    const interactive = !!process.stdin.isTTY;
    if (options.tui && !interactive)
      throw new Error("--tui requires an interactive terminal");
    if (!words.length && !interactive && !options.serve)
      throw new Error("Supply a prompt when standard input is not a terminal");
    const images = [...options.images];
    const interrupt = () => {
      terminal?.cancelQuestions();
      if (!session?.running) {
        terminal?.close();
        return;
      }
      void session
        .interrupt()
        .catch((e) =>
          terminal
            ? terminal.message(e.message)
            : console.error(safe(e.message)),
        );
    };
    if (interactive && !options.serve && !options.tui)
      terminal = new Terminal({
        safe,
        onInterrupt: interrupt,
        onCommand: async (line) => {
          const command = line.split(/\s+/, 1)[0],
            value = line.slice(command.length).trim();
          if (command === "/quit") {
            if (session?.running) await session.interrupt();
            terminal.close();
            return;
          }
          if (command === "/help") {
            terminal.message(
              "/status  Captured effort, Jev health and usage\n/effort auto|LEVEL  Set policy for the next turn\n/image PATH  Attach a local image to the next prompt\n/images  List queued images\n/images clear  Remove queued images\n/log  Show the decision log\n/interrupt  Stop this turn\n/quit  Exit or detach\n\nCommands work while Astra is busy. Effort changes require an idle turn.\nUse up/down for prompt history; no extra history file is written.",
            );
            return;
          }
          if (!session) throw new Error("Session is still starting");
          if (command === "/status") {
            terminal.status(await session.status());
            return;
          }
          if (command === "/log") {
            terminal.message(
              (await session.status()).logPath ??
                "No decision log path available",
            );
            return;
          }
          if (command === "/interrupt") {
            if (session.running) await session.interrupt();
            else terminal.message("No active turn.");
            return;
          }
          if (command === "/effort") {
            if (!value) {
              terminal.message(
                `Available: auto, ${(await session.status()).supportedEfforts.join(", ")}`,
              );
              return;
            }
            await session.setEffort(value);
            terminal.message(
              `Next turn: ${value === "auto" ? "Jev chooses effort" : `Astra ${value}; Jev paused`}.`,
            );
            return;
          }
          if (command === "/image") {
            if (!value)
              throw new Error("Use /image followed by a local file path");
            const path = resolve(
              options.cwd,
              value.replace(/^(["'])(.*)\1$/, "$2"),
            );
            if (!statSync(path).isFile())
              throw new Error("Image attachment is not a file");
            images.push(path);
            terminal.message(
              `Queued image: ${path}\nAstra receives the image; Jev receives only the image count.`,
            );
            return;
          }
          if (command === "/images") {
            if (value === "clear") images.length = 0;
            terminal.message(
              images.length ? images.join("\n") : "No queued images.",
            );
            return;
          }
          throw new Error("Unknown command. Use /help.");
        },
      });
    const logDir = join(homedir(), ".local/share/astra-jev/logs");
    const logPath = options.attach
      ? undefined
      : join(
          logDir,
          `${new Date().toISOString().replaceAll(":", "-")}-${randomUUID()}.jsonl`,
        );
    if (logPath) {
      mkdirSync(logDir, { recursive: true, mode: 0o700 });
      const info = lstatSync(logDir);
      if (
        !info.isDirectory() ||
        info.uid !== process.getuid() ||
        info.mode & 0o077
      )
        throw new Error(
          "Decision log directory must be private and owned by this user",
        );
      logFd = openSync(logPath, "wx", 0o600);
    }
    const record = (event) => {
      if (logFd !== undefined) writeSync(logFd, JSON.stringify(event) + "\n");
    };
    const sessionOptions = {
      nativeUi: options.tui,
      cwd: options.cwd,
      fixedEffort: options.fixedEffort,
      jev: key ? new Jev({ key }) : null,
      secrets: key ? [key] : [],
      record,
      logPath,
      onEvent: (event) => {
        if (options.tui) return;
        if (terminal) terminal.event(event);
        else {
          const message = eventMessage(event);
          if (message) console.error(safe(message));
        }
      },
      onText: (s) => {
        if (!options.tui) process.stdout.write(terminalSafe(s));
      },
      onNotice: (s) =>
        options.tui
          ? undefined
          : terminal
            ? terminal.message(s)
            : console.error(safe(s)),
      threadOptions: options.readOnly
        ? { sandbox: "read-only", approvalPolicy: "never" }
        : {},
      onRequest: async (m) => {
        if (!terminal) return undefined;
        if (
          [
            "item/commandExecution/requestApproval",
            "item/fileChange/requestApproval",
          ].includes(m.method)
        ) {
          terminal.message(JSON.stringify(m.params, null, 2));
          const answer = await terminal.ask("Approve this request? [y/N] ");
          return {
            decision: /^y(?:es)?$/i.test(answer.trim()) ? "accept" : "decline",
          };
        }
        if (m.method === "item/tool/requestUserInput") {
          const answers = {};
          for (const q of m.params.questions) {
            if (q.isSecret) {
              terminal.message(
                "Secret-entry forms require the native Codex client; this question was left unanswered.",
              );
              answers[q.id] = { answers: [] };
              continue;
            }
            terminal.message(
              `${q.question}\n${(q.options ?? []).map((x, n) => `${n + 1}. ${x.label} — ${x.description}`).join("\n")}`,
            );
            const reply = await terminal.ask("Answer (number or text): ");
            const selected = /^\d+$/.test(reply.trim())
              ? q.options?.[Number(reply.trim()) - 1]?.label
              : null;
            answers[q.id] = { answers: [selected ?? reply] };
          }
          return { answers };
        }
        return undefined;
      },
    };
    session = options.attach
      ? new SessionClient({
          path: await sessionSocket(options.attach),
          ...sessionOptions,
        })
      : new Session(sessionOptions);
    session.transport.on("closed", () => terminal?.close());
    const info = await session.open({ resume: options.resume });
    if (terminal) {
      terminal.header(info);
      if (info.status) terminal.status(info.status);
    } else
      console.error(
        `Thread: ${info.threadId}\nMode: ${info.mode}\nDecision log: ${info.logPath ?? logPath}`,
      );
    if (options.tui) {
      const name = `tui-${process.pid}`;
      host = new SessionHost({
        session,
        info,
        path: await sessionSocket(name),
        observerOnly: true,
      });
      await host.listen();
      const { NativeTui } = await import("../src/native-tui.mjs");
      nativeTui = new NativeTui({ session, record });
      await nativeTui.open();
      console.error(
        `Native Codex TUI with Jev control. Live evidence: astra-jev-control --status ${name}\nOne owned thread; use Ctrl-C to interrupt before follow-ups during a turn.\nJev decisions appear inline. Confirmed changes say "Astra changed to ... effort".\nThe native footer may show its initial setting; inline notices and --status show captured effort.`,
      );
      const stop = () => {
        void nativeTui
          .close()
          .then(() => host.close())
          .catch(() => {});
      };
      process.on("SIGTERM", stop);
      process.on("SIGINT", stop);
      const result = await nativeTui.launch({
        cwd: options.cwd,
        prompt: words.join(" ") || undefined,
      });
      if (result.code) process.exitCode = result.code;
    } else if (options.serve) {
      host = new SessionHost({
        session,
        info,
        path: await sessionSocket(options.serve),
      });
      await host.listen();
      const stop = () => {
        void host.close().catch((error) => console.error(safe(error.message)));
      };
      process.on("SIGINT", stop);
      process.on("SIGTERM", stop);
      console.error(
        `Session ${options.serve} ready. Attach with: astra-jev-control --attach ${options.serve}`,
      );
      await host.done;
    } else {
      process.on("SIGINT", interrupt);
      process.on("SIGTERM", () => {
        terminal?.cancelQuestions();
        terminal?.close();
        if (session.running) void session.interrupt().catch(() => {});
      });
      if (words.length) {
        await session.run(words.join(" "), { images });
        console.log();
        if (terminal) terminal.status(await session.status());
      } else
        while (true) {
          const prompt = await terminal.prompt();
          if (prompt === null) break;
          const attachments = images.splice(0);
          try {
            await session.run(prompt, { images: attachments });
          } catch (error) {
            terminal.message(error.message);
          }
          console.log();
          if (!terminal.closed) terminal.status(await session.status());
        }
    }
  }
} catch (e) {
  console.error(terminalSafe(redact(e.message, key ? [key] : [])));
  process.exitCode = 1;
} finally {
  terminal?.close();
  await nativeTui?.close();
  if (host) await host.close();
  else await session?.close();
  if (logFd !== undefined) closeSync(logFd);
}
