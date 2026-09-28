# Changelog

## 0.0.6 — 2026-09-28

- Add the bundled `$astra-jev` Codex skill for project configuration, doctor checks and live status. Setup and managed launches install it automatically; custom copies and edits are preserved.
- Add `astra-jev-control config`, `config set KEY VALUE`, and `install-skill` for validated settings and skill installation without provider calls.
- Remove per-turn mode/permission banners and resume explanations from the TUI. Show initial effort choices and changes; unchanged choices stay silent. Model transitions and failures remain visible.
- Remove wrapper-owned sandbox, network, approval and writable-directory overrides. Fresh and resumed sessions use native Codex permissions; Jev only chooses Astra effort.
- Stop overriding shell-snapshot and terminal-rendering defaults. Direct launches forward native arguments unchanged.
- Retire `resumePermissions` and `noAltScreen`; older project files remain readable, with those fields ignored. Use native Codex settings and `--no-alt-screen` when desired.
- Preserve native permission changes through turns, model switches, settings updates and reconnections.

**Upgrade:** restart Astra-Jev to load the changes. Native Codex permissions now apply, including full access when that is already your Codex setting. Existing project files are preserved. This remains a macOS beta; fresh-machine authentication testing is pending.

## 0.0.5 — 2026-09-28

### Features
- [NEW FEATURE] Add `resumePermissions: "workspace-write"` so resumed conversations can edit the launch project while Jev continues choosing effort before each turn.

### Fixes
- [BUG FIX] Keep the selected workspace scope across model switches, settings changes and reconnections. Native temporary directories remain available; extra writable roots and sandbox network access stay disabled.

### Improvements
- [IMPROVED] Explain the native resume effort-verification limitation once per session, then show concise effort selections. Quiet mode stays quiet.
- [IMPROVED] Document the difference between effort confirmation and file permissions, plus how to enable writable resumes and restart.
- [IMPROVED] Cover permission validation, settings preservation and reconnect behavior with regression tests; verify an actual project write and an outside-project denial through the stock Codex TUI.

Resume remains read-only by default; existing settings are preserved. This remains a macOS beta for stock Codex 0.157.1. Resumed sessions select effort per turn, without native capture confirmation or mid-turn adaptation. A separate clean-Mac trial remains pending.

## 0.0.4 — 2026-09-28

### Features
- [NEW FEATURE] Add `verbose: false` in project settings to hide routine effort notices and per-turn banners while Jev, decision logs and live status keep working.

### Fixes
- [BUG FIX] Keep completed fast turns cleared when completion arrives before the turn-start continuation, preventing stale turn IDs from blocking follow-up prompts.
- [BUG FIX] Announce Jev inactivity once when leaving Astra, stay silent across subsequent non-Astra turns and model changes, and reset the notice when returning to Astra.

### Improvements
- [IMPROVED] Keep failure and model-switch notices visible in quiet mode; preserve existing verbosity by default.
- [IMPROVED] Cover quiet fresh and resumed sessions, decision evidence, invalid settings and repeated model switches with regression tests.

This remains a macOS beta for stock Codex 0.157.1. Restart Astra-Jev after changing project settings. A separate clean-Mac trial remains pending.

## 0.0.3 — Unreleased

Validation candidate superseded by 0.0.4 after CI exposed the fast-turn completion race. Its tag is retained; no installable release was published.

## 0.0.2 — 2026-09-28

### Fixes
- [BUG FIX] Keep the privacy prompt visible during terminal redraws and explicitly explain that YES accepts while Enter alone cancels.
- [BUG FIX] Allow the native resume picker to reconnect without a WebSocket handshake failure; keep late replies on their original connection.
- [BUG FIX] Let Esc from the resume picker start a fresh adaptive session with native project permissions, updated live status and cleanup of the unused picker backend.
- [BUG FIX] Suspend Jev when another model is selected in the native TUI and restore it on return to Astra, preserving native effort settings, conversation ownership and read-only resume permissions.

### Improvements
- [IMPROVED] Document resume-picker controls and update installation instructions for this release.
- [IMPROVED] Add regression coverage for consent rendering, hidden key input, connection handoff, fresh-session preparation, observer rebinding and model-switch lifecycle behavior.

This remains a macOS beta for stock Codex 0.157.1. Existing read-only resume policy and known limits remain; a separate clean-Mac trial is still pending.

## 0.0.1 — 2026-09-28

First tagged public release. The earlier 0.4.x numbers below were preparation versions; community releases start at 0.0.1. This remains an experimental macOS beta.

### Features
- [NEW FEATURE] Tagged GitHub release with an installable archive and SHA-256 checksum.
- [NEW FEATURE] Jev effort decisions through stock Codex, native TUI notices, project configuration and argument forwarding.

### Improvements
- [IMPROVED] Repeatable release installation and documented compatibility, privacy and known limitations.

Known limits: Codex 0.157.1 only; incomplete checkpoint coverage; resume adapts per turn; long home paths can prevent startup. Isolated public installation and real native LOW/HIGH capture passed on the maintainer's Mac; a separate clean-Mac trial remains pending.

## Preparation history

### 0.4.2-beta.1 — 2026-09-28

#### Improvements
- [IMPROVED] Warn during installation guidance about long home paths, the macOS socket limit and the startup error.

### 0.4.1-beta.1 — 2026-09-28

#### Features
- [NEW FEATURE] Public source beta at `brunocfalcao/astra-jev`.

#### Improvements
- [IMPROVED] Illustrated README, original SVG logo, icon and banner, and direct repository installation.
- [IMPROVED] Visible macOS CI results and community contribution guidance.

#### Fixes
- [BUG FIX] Include the example project configuration in the source repository.

### 0.4.0-beta.1 — Unreleased

- Project JSON configuration and native Codex argument forwarding.
- Native resume picker and `--last`; resumed Jev sessions default to read-only.
- Adaptive, per-turn, fixed and inactive mode reporting.
- Optional `requireJev` prevents unsupported fallback and stops on evaluator/publication failure.
- First-run privacy acknowledgment and hidden key setup.
- Package allowlist, isolated install/reinstall/uninstall checks and macOS CI.
- Public contributor, privacy, security, compatibility and release documentation.

This is an experimental macOS beta, not a claim of universal checkpoint coverage or measured savings. No Codex binary is bundled or patched.
