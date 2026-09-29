---
name: astra-jev
description: Configure Astra-Jev, check Jev and Astra connectivity, inspect live effort decisions, and troubleshoot the integration. Use for Astra-Jev settings, setup, doctor, or status requests.
---

# Astra-Jev

Manage the installed Astra-Jev integration through `astra-jev-control`. Start with its `--help` when the installed interface is unknown. `astra-jev` forwards arguments to Codex: `astra-jev doctor` is Codex's command, not Jev's diagnostic.

## Enable after manual override

When the user types `$astra-jev enable`, run `astra-jev-control enable` in this chat. It targets CODEX_THREAD_ID and enables only its live host. During a turn, activation starts next turn. Selecting a supported model alone does not reactivate Jev. Report command errors; do not change project configuration or choose another session.

## Configuration

- Run `astra-jev-control config` in the requested project to show the file path and effective settings. Use `--cwd PATH` when the project differs from the current directory.
- Apply the user's requested setting with `astra-jev-control config set KEY VALUE`. This validates the value before writing and preserves other settings.
- The project file is `astra-jev.json`. New files include `"effortAdjustment": "default"`; valid older files are safely upgraded to persist that default while preserving their existing values. Invalid files are reported without changes. Users can also edit this JSON directly.
- `effortAdjustment`: `conservative` lowers Jev one supported level (floor Low), `default` preserves its choice, `optimistic` raises one level with a Max ceiling. An Ultra choice becomes Max in either adjusted mode; `default` preserves Ultra. Fixed effort is unchanged. Logs retain `jevEffort` separately from the applied `effort`. Set with `astra-jev-control config set effortAdjustment conservative`; restart required.
- Supported controls: `enabled` and `verbose` are booleans; `fixedEffort` is `null` for Jev or `low`, `medium`, `high`, `xhigh`, `max`, `ultra`; `requireJev` refuses launches or model switches that would leave Jev inactive. `enabled: false` or a fixed effort cannot be combined with `requireJev: true`.
- Example: `astra-jev-control config set verbose false` hides routine notices while evaluation and decision evidence continue. `astra-jev-control config set fixedEffort null` restores Jev for the next launch.
- Adaptive sessions automatically apply conservative adjustment while shared Codex quota usage is above pace (remaining allowance percent below remaining period percent). On or under pace restores the configured adjustment. Missing or expired readings preserve settings; fixed effort is unchanged. One above-pace notice is shown per session, at launch or first activation, including resumed sessions. Later crossings remain silent. Status reports pace at the last decision.
- Existing processes retain loaded settings. Explain that the user must exit and relaunch Astra-Jev; do not terminate another working session automatically.

Codex owns filesystem, network, approvals, shell snapshots and terminal rendering. Do not modify native permissions to fix an effort/configuration request. Obsolete `resumePermissions` and `noAltScreen` fields are ignored. If a native permission change is explicitly requested, use Codex's supported controls and preserve the user's intended scope.

## Doctor and live status

- `astra-jev-control status --table` shows cumulative usage for the current launch folder. Restart after upgrading to record project attribution. Older unattributed logs are excluded; resumed or missing usage is incomplete. Only complete paired project-attributed benchmark reports produce measured token differences, separate from ordinary project usage. No provider calls or inferred savings.

- `astra-jev-control doctor` checks the installed Codex version, Astra availability, authentication type and real Jev connectivity. It can make a billable TypeSafe request. Existing privacy consent is handled by the CLI; do not set the acknowledgment environment variable to skip a user's pending consent.
- `astra-jev-control status` reads evidence for CODEX_THREAD_ID without calling Jev. Outside a session use `status --list`, then `status --thread THREAD_ID`; `status --latest` explicitly selects the newest log. Jev totals include every evaluated request, discarded decisions, failures, retries and cumulative evaluation time; incomplete usage is labelled. For a running session with a verified host name, use: `astra-jev-control --status tui-PID`. Do not invent a session name or treat old logs as live evidence.
- If setup or credentials are missing, use `astra-jev-control setup` in an interactive terminal. Never ask the user to paste a key into chat or print credential files. Setup installs this skill too; `astra-jev-control install-skill` repairs an absent package-managed copy while preserving custom edits.

Report what was observed: selected effort is not necessarily captured effort. On resumed conversations, Jev selects initial effort and reassesses at each supported local-tool checkpoint within the turn. Native live capture confirmation and generation counts remain unavailable; resumed sessions do not use generation leases and can make more Jev requests. An acknowledged effort update is not a captured-effort event. Astra and GPT 6.1 Sol support adaptive effort. Launch `astra-jev` normally; the native Codex model selection is detected automatically. Manual model changes pause Jev; explicitly enable it on either supported model. Unsupported models remain inactive. A direct-stock launch cannot reactivate Jev within that process.

For a failure, check effective project settings, doctor, and the relevant live status or bounded decision records. Do not change unrelated application code, run cleaners, or query private databases just to diagnose the integration. Finish with the setting or finding, the check performed, and any restart required.
