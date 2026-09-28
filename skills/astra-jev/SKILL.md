---
name: astra-jev
description: Configure Astra-Jev, check Jev and Astra connectivity, inspect live effort decisions, and troubleshoot the integration. Use for Astra-Jev settings, setup, doctor, or status requests.
---

# Astra-Jev

Manage the installed Astra-Jev integration through `astra-jev-control`. Start with its `--help` when the installed interface is unknown. `astra-jev` forwards arguments to Codex: `astra-jev doctor` is Codex's command, not Jev's diagnostic.

## Configuration

- Run `astra-jev-control config` in the requested project to show the file path and effective settings. Use `--cwd PATH` when the project differs from the current directory.
- Apply the user's requested setting with `astra-jev-control config set KEY VALUE`. This validates the value before writing and preserves other settings.
- Supported controls: `enabled` and `verbose` are booleans; `fixedEffort` is `null` for Jev or `low`, `medium`, `high`, `xhigh`, `max`, `ultra`; `requireJev` refuses launches or model switches that would leave Jev inactive. `enabled: false` or a fixed effort cannot be combined with `requireJev: true`.
- Example: `astra-jev-control config set verbose false` hides routine notices while evaluation and decision evidence continue. `astra-jev-control config set fixedEffort null` restores Jev for the next launch.
- Existing processes retain loaded settings. Explain that the user must exit and relaunch Astra-Jev; do not terminate another working session automatically.

Codex owns filesystem, network, approvals, shell snapshots and terminal rendering. Do not modify native permissions to fix an effort/configuration request. Obsolete `resumePermissions` and `noAltScreen` fields are ignored. If a native permission change is explicitly requested, use Codex's supported controls and preserve the user's intended scope.

## Doctor and live status

- `astra-jev-control doctor` checks the installed Codex version, Astra availability, authentication type and real Jev connectivity. It can make a billable TypeSafe request. Existing privacy consent is handled by the CLI; do not set the acknowledgment environment variable to skip a user's pending consent.
- `astra-jev-control status` reads recent local evidence without calling Jev. For a running session, use the exact name printed at launch: `astra-jev-control --status tui-PID`. Do not invent a session name or treat old logs as live evidence.
- If setup or credentials are missing, use `astra-jev-control setup` in an interactive terminal. Never ask the user to paste a key into chat or print credential files. Setup installs this skill too; `astra-jev-control install-skill` repairs an absent package-managed copy while preserving custom edits.

Report what was observed: selected effort is not necessarily captured effort. On resumed conversations, Jev selects initial effort and reassesses at each supported local-tool checkpoint within the turn. Native live capture confirmation and generation counts remain unavailable; resumed sessions do not use generation leases and can make more Jev requests. An acknowledged effort update is not a captured-effort event. When another model is selected, Jev is inactive until Astra returns. A direct-stock launch cannot reactivate Jev within that process.

For a failure, check effective project settings, doctor, and the relevant live status or bounded decision records. Do not change unrelated application code, run cleaners, or query private databases just to diagnose the integration. Finish with the setting or finding, the check performed, and any restart required.
