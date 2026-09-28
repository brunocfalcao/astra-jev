<p align="center">
  <img src="assets/banner.svg" width="100%" alt="Astra-Jev — reasoning effort, in motion. Stock Codex. Visible decisions." />
</p>

<p align="center">
  <strong>Adaptive reasoning for GPT-6 Astra. Powered by Jev. Built on stock Codex.</strong><br />
  v1.0.0-rc.1 · macOS beta preview · Stock Codex · Node 22.19+ · MIT
</p>

<p align="center">
  <a href="https://github.com/brunocfalcao/astra-jev/actions/workflows/ci.yml"><img src="https://github.com/brunocfalcao/astra-jev/actions/workflows/ci.yml/badge.svg" alt="macOS compatibility checks" /></a>
</p>

<p align="center">
  <a href="#install-and-start">Get started</a> ·
  <a href="#configure-with-astra-jev">Use the skill</a> ·
  <a href="#know-what-is-running">See the modes</a> ·
  <a href="PRIVACY.md">Privacy</a> ·
  <a href="docs/DEMO.md">Walkthrough</a> ·
  <a href="CONTRIBUTING.md">Contribute</a>
</p>

---

**Let the next step set the effort.** Jev chooses effort and a short generation lease. Supported local-tool checkpoints let it reassess during a task. The native Codex TUI shows selected versus confirmed effort. This is experimental; it does not guarantee lower cost, better answers, or a checkpoint before every generation.

| Your Codex, intact | Decisions you can inspect | Control you can keep |
| :--- | :--- | :--- |
| Native TUI, tools and account. No binary patches. | Inline notices distinguish selected effort from confirmed capture. | Native Codex permissions, project settings and optional strict Jev enforcement. |

## Install and start

Install stock Codex separately and sign in with an account that has Astra access; see [compatibility](docs/COMPATIBILITY.md). Jev needs a separate TypeSafe API key.

**Codex upgrades are allowed.** Managed sessions use your installed stock Codex without version validation. If an upgrade breaks the integration, [report it](https://github.com/brunocfalcao/astra-jev/issues) or open a pull request.

Install the latest tagged macOS beta:

```sh
npm install --global --ignore-scripts 'https://github.com/brunocfalcao/astra-jev/releases/download/v1.0.0-rc.1/astra-jev-1.0.0-rc.1.tgz'
astra-jev-control setup
astra-jev-control doctor
```

The [release page](https://github.com/brunocfalcao/astra-jev/releases/tag/v1.0.0-rc.1) includes the archive, SHA-256 checksum and tested scope. No Git installation is needed for the archive. The macOS CI badge links to the exact checks and results; a clean-Mac trial remains pending.

Long home paths use a short owner-only socket directory under `/tmp`; standard home paths retain their existing socket location.

**Enter your own TypeSafe/Jev API key during `astra-jev-control setup`.** Each user supplies their own key; Codex sign-in does not provide it, and no shared key is bundled. Run setup in an interactive terminal after installation:

1. If asked to allow the data flow, **type `YES`, then press Enter**. Enter alone cancels consent; no evaluator request is sent.
2. At `TypeSafe API key (hidden; Enter skips):`, paste your key and press Enter. Input stays hidden. Enter alone skips key storage; adaptive sessions still require an available key.
3. The entered key is saved in `~/.config/astra-jev/credentials` with owner-only permissions. Run `astra-jev-control doctor` to verify Astra and Jev connectivity.

If a key already exists in `TYPESAFE_API_KEY` or a [supported local credential file](PRIVACY.md#key-setup), setup reuses it and skips the key prompt. Keep keys out of `astra-jev.json`, chat and issues.

Interactive adaptive launches guide you through hidden key setup when no key exists. Skipping key entry cancels launch. Noninteractive use requires setup beforehand. Read [privacy](PRIVACY.md) before using confidential projects.

In a project folder:

```sh
astra-jev
astra-jev --sandbox read-only "Explain this code"
astra-jev resume
astra-jev resume --last
astra-jev resume THREAD_ID "Continue"
```

All arguments belong to Codex. `astra-jev --help` is Codex help; `astra-jev doctor` is Codex doctor. Wrapper diagnostics use **`astra-jev-control`**. Native TUI is the default; no `--tui` is needed.

In the resume picker, **Enter** opens the selected conversation. **Esc** starts a fresh session with the same effort settings and native project permissions as launching `astra-jev` directly. Codex owns permissions for both fresh and resumed conversations.

**Switch models with `/model`.** Selecting a model other than Astra makes Jev inactive in the same conversation. Codex uses that model's native effort setting; Jev makes no evaluator requests or effort updates for its turns. Selecting Astra again restores the session's adaptive or fixed policy automatically. Inline notices and live status show the transition. A selection made during a running turn takes effect after that turn finishes. `requireJev: true` blocks non-Astra selection.

## Know what is running

Normal turns show the initial Jev effort choice and subsequent changes. Unchanged choices stay silent; mode and permission details live in status, not per-turn banners. Set `"verbose": false` in `astra-jev.json` to hide routine effort messages too. Jev keeps adapting effort; decision logs and live status remain available. Failures and model-switch notices remain visible. Leaving Astra shows one inactive notice; subsequent non-Astra turns and model changes stay quiet. Returning to Astra resets that notice for the next departure.

```text
Astra set to LOW effort (Jev)
Astra changed to HIGH effort (Jev)
```

- **ADAPTIVE:** Jev controls fresh and resumed conversations at supported local-tool checkpoints.
- **FIXED:** the configured effort is used; Jev is inactive.
- **INACTIVE:** a non-Astra model is selected in the managed conversation, or arguments run directly through stock Codex. The displayed notice gives the reason.

**Resume now adapts mid-turn.** Jev chooses the initial effort, then reassesses after each supported local tool call. An acknowledged update appears as `Jev selected HIGH effort for the next step`. Stock Codex 0.157.1 omits raw generation events on `thread/resume`, so live capture confirmation and generation counts remain unavailable. Resumed sessions therefore do not apply generation leases and can make more Jev requests than fresh sessions. Native permissions stay unchanged. Resuming the last conversation is supported.

“Changed” requires a native capture event. Selected, unavailable and unconfirmed decisions are labelled accordingly. The native footer can show an earlier setting; use the inline evidence and the printed live-status command:

```sh
astra-jev-control --status tui-12345
astra-jev-control status --list
astra-jev-control status --thread THREAD_ID
```

The first command queries that live host. Recorded status uses the current CODEX_THREAD_ID when available; otherwise select --thread or explicitly --latest. It is not a liveness check. Jev totals include discarded evaluations, failures, HTTP retries and cumulative evaluation time; unavailable usage is labelled incomplete.

**`Jev: responding` describes the last successful evaluator request, not the health of the whole Astra turn.** Once Jev returns its choice, Codex handles the model request and tools. A long native `Working` interval alone does not identify a Jev failure; check decision timing and subsequent turn activity before assigning a cause.

## Configure with `$astra-jev`

Use natural language inside Codex:

```text
$astra-jev turn off effort notices for this project
$astra-jev check whether Jev and Astra are working
$astra-jev show this project's settings
```

The skill installs automatically during `astra-jev-control setup` or the first managed launch. It is bundled with the package; no separate download or npm install script runs. Package-managed copies update on subsequent setup or managed launches. Existing custom skills and personal edits are preserved.

Installation uses `$CODEX_HOME/skills/astra-jev`, or `~/.codex/skills/astra-jev` when `CODEX_HOME` is unset. If Codex does not list it yet, restart Codex. To install or repair a missing copy explicitly:

```sh
astra-jev-control install-skill
```

The skill reads and updates validated project settings, runs doctor checks, and inspects decision evidence. Doctor can make a billable TypeSafe request; status and configuration commands do not call Jev. Credentials stay out of chat. Native permissions remain under Codex's control.

Prefer direct commands? From your project:

```sh
astra-jev-control config
astra-jev-control config set verbose false
astra-jev-control config set fixedEffort null
```

Add `--cwd PATH` to target another project. Settings changes apply after restarting Astra-Jev.

## Project settings

The first launch creates `astra-jev.json` in the current project directory (or local `--cd` directory). Existing files are preserved. Settings take effect in new processes. Keep credentials out of this file.

```json
{
  "version": 1,
  "enabled": true,
  "verbose": true,
  "fixedEffort": null,
  "requireJev": false
}
```

| Setting | Meaning |
| --- | --- |
| `enabled` | Enable the managed Astra integration when compatible. |
| `verbose` | Default `true`. Set `false` to hide routine effort notices in the managed TUI. Jev, decision logs, live status, failures and model-switch notices remain active. Restart Astra-Jev after changing this setting. |
| `fixedEffort` | `null` for Jev; otherwise `low`, `medium`, `high`, `xhigh`, `max`, or `ultra`. |
| `requireJev` | Refuse direct-stock/fixed launches and non-Astra model switches; stop on evaluator or effort-publication failure. Supported checkpoint coverage still applies. |

**Codex owns permissions.** Astra-Jev does not set a sandbox, block network access, change approval policy or replace writable directories. Use Codex's own configuration and `/permissions` controls. Jev only controls Astra effort. Existing `resumePermissions` and `noAltScreen` fields from older Astra-Jev versions are accepted but ignored; no project file is rewritten automatically. To request inline terminal rendering, pass the native `--no-alt-screen` flag.

Native CLI permission overrides on resume, such as `astra-jev resume --sandbox workspace-write`, currently run stock Codex without Jev because stock remote resume rejects those flags. Normal `astra-jev resume` uses native permissions with Jev active.

## Scope and limits

Other subcommands (`exec`, `review`, `fork`, etc.), launching with another model, external `--remote`, profiles, worktrees, additional workspace directories and incompatible overrides use stock Codex directly. Unknown future flags are passed through. `requireJev: true` blocks this fallback. A missing Jev key is an error, not an automatic fallback. Automatic Jev reactivation is available inside a managed session; a direct-stock launch stays unmanaged.

Shell snapshots and terminal rendering follow native Codex settings. Direct launches forward your arguments unchanged. Endpoint protection is never changed; no zero-alert guarantee is made.

One managed TUI owns one thread. Native follow-up input and skills, including `$astra-jev doctor`, work during a turn. Accepted input updates Jev's bounded context and expires its current lease; fresh and resumed threads reassess at supported checkpoints. Hosted tools, some asynchronous continuations and child threads remain outside checkpoint coverage. Fresh-session leases are measured in native generations, not tool calls; resumed sessions reassess each supported checkpoint without a generation lease. See [architecture](docs/ARCHITECTURE.md) and [compatibility](docs/COMPATIBILITY.md).

## Update, uninstall, contribute

To update, install the archive from the latest reviewed release using the command above, then restart Astra-Jev. Source installations can use `git+https://github.com/brunocfalcao/astra-jev.git#v1.0.0-rc.1` with Git installed; use a reviewed tag or commit SHA for repeatability. Project settings and credentials survive reinstall. Uninstall with:

```sh
npm uninstall --global astra-jev
```

This removes the commands, not the installed skill, project settings, credentials, decision logs or Codex history. You can remove the `astra-jev` folder from your Codex skills directory separately. Instructions for optional app-owned data cleanup are in [privacy](PRIVACY.md).

Development: `npm ci --ignore-scripts`, `npm run check`, `npm run pack:check`, `npm run test:install`. Tests use synthetic fixtures; CI requires no service credentials. See [contributing](CONTRIBUTING.md), [release procedure](docs/RELEASING.md), [demo](docs/DEMO.md), and [security reporting](SECURITY.md).

The visual identity is included as editable vectors: [logo](assets/logo.svg), [icon](assets/icon.svg), and [banner](assets/banner.svg).

MIT licensed. Inspired by [Astra-Ares](https://github.com/miuuyy/Astra-Ares); see [third-party notices](THIRD_PARTY_NOTICES.md). Not affiliated with OpenAI or TypeSafe.

---

<p align="center">
  <img src="assets/icon.svg" width="40" height="40" alt="Astra-Jev icon" /><br />
  <sub>Small controller. Visible decisions. Stock Codex.</sub>
</p>

See [1.0 acceptance gates](docs/1.0-READINESS.md) for the repeatable cost benchmark and independent Mac checklist.
