<p align="center">
  <img src="assets/banner.svg" width="100%" alt="Astra-Jev — reasoning effort, in motion. Stock Codex. Visible decisions." />
</p>

<p align="center">
  <strong>Adaptive reasoning for GPT-6 Astra. Powered by Jev. Built on stock Codex.</strong><br />
  v0.0.3 · macOS beta preview · Codex 0.157.1 · Node 22.19+ · MIT
</p>

<p align="center">
  <a href="https://github.com/brunocfalcao/astra-jev/actions/workflows/ci.yml"><img src="https://github.com/brunocfalcao/astra-jev/actions/workflows/ci.yml/badge.svg" alt="macOS compatibility checks" /></a>
</p>

<p align="center">
  <a href="#install-and-start">Get started</a> ·
  <a href="#know-what-is-running">See the modes</a> ·
  <a href="PRIVACY.md">Privacy</a> ·
  <a href="docs/DEMO.md">Walkthrough</a> ·
  <a href="CONTRIBUTING.md">Contribute</a>
</p>

---

**Let the next step set the effort.** Jev chooses effort and a short generation lease. Supported local-tool checkpoints let it reassess during a task. The native Codex TUI shows selected versus confirmed effort. This is experimental; it does not guarantee lower cost, better answers, or a checkpoint before every generation.

| Your Codex, intact | Decisions you can inspect | Control you can keep |
| :--- | :--- | :--- |
| Native TUI, tools and account. No binary patches. | Inline notices distinguish selected effort from confirmed capture. | Read-only resume, explicit modes and optional strict Jev enforcement. |

## Install and start

Install stock Codex separately and sign in with an account that has Astra access. Use the exact supported Codex version; see [compatibility](docs/COMPATIBILITY.md). Jev needs a separate TypeSafe API key.

Install the latest tagged macOS beta:

```sh
npm install --global --ignore-scripts 'https://github.com/brunocfalcao/astra-jev/releases/download/v0.0.3/astra-jev-0.0.3.tgz'
astra-jev-control setup
astra-jev-control doctor
```

The [release page](https://github.com/brunocfalcao/astra-jev/releases/tag/v0.0.3) includes the archive, SHA-256 checksum and tested scope. No Git installation is needed for the archive. The macOS CI badge links to the exact checks and results; a clean-Mac trial remains pending.

> [!WARNING]
> **Long home-directory paths can prevent startup.** Managed TUI sessions and named hosts create a Unix socket under `~/.local/share/astra-jev/run/`. On macOS, the complete socket path must fit within **103 bytes**. Long usernames or deeply nested home directories can trigger `Session socket path is too long`; the affected launch stops before any model turn. This beta has no setting for a shorter socket directory yet. Moving your project does not shorten this home-based path. If affected, [report the error](https://github.com/brunocfalcao/astra-jev/issues/new/choose) with your home-path byte length, without sharing private paths or credentials.

`setup` explains the data flow and asks for acknowledgment: **type `YES`, then press Enter** to allow it. Enter alone cancels setup; no evaluator request is sent. It can securely store a key using hidden terminal input and never displays the key. An existing `TYPESAFE_API_KEY` environment variable also works. Read [privacy](PRIVACY.md) before using confidential projects.

In a project folder:

```sh
astra-jev
astra-jev --sandbox read-only "Explain this code"
astra-jev resume
astra-jev resume --last
astra-jev resume THREAD_ID "Continue"
```

All arguments belong to Codex. `astra-jev --help` is Codex help; `astra-jev doctor` is Codex doctor. Wrapper diagnostics use **`astra-jev-control`**. Native TUI is the default; no `--tui` is needed.

In the resume picker, **Enter** opens the selected conversation. **Esc** starts a fresh session with the same effort settings and native project permissions as launching `astra-jev` directly. The read-only resume policy applies when reopening a saved conversation.

**Switch models with `/model`.** Selecting a model other than Astra makes Jev inactive in the same conversation. Codex uses that model's native effort setting; Jev makes no evaluator requests or effort updates for its turns. Selecting Astra again restores the session's adaptive, per-turn or fixed policy automatically. Inline notices and live status show the transition. A selection made during a running turn takes effect after that turn finishes. `requireJev: true` blocks non-Astra selection.

## Know what is running

Astra turns show their mode and permissions by default. Set `"verbose": false` in `astra-jev.json` to hide routine effort messages and per-turn banners. Jev keeps adapting effort; decision logs and live status remain available. Failures and model-switch notices remain visible. Leaving Astra shows one inactive notice; subsequent non-Astra turns and model changes stay quiet. Returning to Astra resets that notice for the next departure.

```text
Jev mode: ADAPTIVE | Permissions: readOnly | Require Jev: off
Astra set to LOW effort (Jev)
Astra changed to HIGH effort (Jev)
```

- **ADAPTIVE:** Jev controls the owned thread at supported local-tool checkpoints.
- **PER-TURN:** resumed thread; Jev chooses each user turn's effort. Native capture verification and mid-turn adaptation are unavailable.
- **FIXED:** the configured effort is used; Jev is inactive.
- **INACTIVE:** a non-Astra model is selected in the managed conversation, or arguments run directly through stock Codex. The displayed notice gives the reason.

“Changed” requires a native capture event. Selected, unavailable and unconfirmed decisions are labelled accordingly. The native footer can show an earlier setting; use the inline evidence and the printed live-status command:

```sh
astra-jev-control --status tui-12345
astra-jev-control status
```

The first command queries that live host. The second reads recorded evidence and is not a liveness check.

## Project settings

The first launch creates `astra-jev.json` in the current project directory (or local `--cd` directory). Existing files are preserved. Settings take effect in new processes. Keep credentials out of this file.

```json
{
  "version": 1,
  "enabled": true,
  "verbose": true,
  "fixedEffort": null,
  "noAltScreen": true,
  "requireJev": false,
  "resumePermissions": "read-only"
}
```

| Setting | Meaning |
| --- | --- |
| `enabled` | Enable the managed Astra integration when compatible. |
| `verbose` | Default `true`. Set `false` to hide routine effort notices and per-turn mode banners in the managed TUI. Jev, decision logs, live status, failures and model-switch notices remain active. Restart Astra-Jev after changing this setting. |
| `fixedEffort` | `null` for Jev; otherwise `low`, `medium`, `high`, `xhigh`, `max`, or `ultra`. |
| `noAltScreen` | Prefer inline terminal rendering. |
| `requireJev` | Refuse direct-stock/fixed launches and non-Astra model switches; stop on evaluator or effort-publication failure. Supported checkpoint coverage still applies. |
| `resumePermissions` | Default `read-only` pins managed resumed turns to read-only with network access disabled. `codex` explicitly opts into Codex's current permissions. |

**Resume is read-only by default.** This prevents a saved read-only conversation from silently reopening with broader current settings. The policy is checked before a resumed turn and enforced on every managed turn. To request native permission overrides directly, use Codex flags, such as `astra-jev resume --sandbox workspace-write`; that path currently runs without Jev. Changing the JSON policy to `codex` also relinquishes the read-only pin, so review the displayed permissions before proceeding.

## Scope and limits

Other subcommands (`exec`, `review`, `fork`, etc.), launching with another model, external `--remote`, profiles, worktrees, additional workspace directories and incompatible overrides use stock Codex directly. Unknown future flags are passed through. `requireJev: true` blocks this fallback. A missing Jev key is an error, not an automatic fallback. Automatic Jev reactivation is available inside a managed session; a direct-stock launch stays unmanaged.

The wrapper prepends process-local disabled shell-snapshot defaults to local stock launches. Native explicit overrides follow Codex precedence. An external server owns its own settings. Endpoint protection is never changed; no zero-alert guarantee is made.

One managed TUI owns one thread. Interrupt before follow-up input during a turn. Hosted tools, some asynchronous continuations and child threads remain outside checkpoint coverage. A lease is measured in native generations, not tool calls. See [architecture](docs/ARCHITECTURE.md) and [compatibility](docs/COMPATIBILITY.md).

## Update, uninstall, contribute

To update, install the archive from the latest reviewed release using the command above, then restart Astra-Jev. Source installations can use `git+https://github.com/brunocfalcao/astra-jev.git#v0.0.3` with Git installed; use a reviewed tag or commit SHA for repeatability. Project settings and credentials survive reinstall. Uninstall with:

```sh
npm uninstall --global astra-jev
```

This removes the commands, not project settings, credentials, decision logs or Codex history. Instructions for optional app-owned data cleanup are in [privacy](PRIVACY.md).

Development: `npm ci --ignore-scripts`, `npm run check`, `npm run pack:check`, `npm run test:install`. Tests use synthetic fixtures; CI requires no service credentials. See [contributing](CONTRIBUTING.md), [release procedure](docs/RELEASING.md), [demo](docs/DEMO.md), and [security reporting](SECURITY.md).

The visual identity is included as editable vectors: [logo](assets/logo.svg), [icon](assets/icon.svg), and [banner](assets/banner.svg).

MIT licensed. Inspired by [Astra-Ares](https://github.com/miuuyy/Astra-Ares); see [third-party notices](THIRD_PARTY_NOTICES.md). Not affiliated with OpenAI or TypeSafe.

---

<p align="center">
  <img src="assets/icon.svg" width="40" height="40" alt="Astra-Jev icon" /><br />
  <sub>Small controller. Visible decisions. Stock Codex.</sub>
</p>
