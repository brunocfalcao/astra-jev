# Changelog

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
