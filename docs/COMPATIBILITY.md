# Compatibility

| Component | Beta scope |
| --- | --- |
| Operating system | macOS; other platforms are not supported by this package release |
| Node | 22.19+ required; local validation uses 22.22.2 |
| Codex | Installed stock Codex; no version pin or launch-time version validation |
| Model | Jev controls `gpt-6-astra` and `gpt-6.1-sol`, account availability required; other models selected inside the TUI run with Jev inactive |
| Evaluator | TypeSafe `jev-1.13.0`, separate API key |
| IPC | Unix sockets only, owner-only directories and sockets |

Codex upgrades do not require prior validation. If a version breaks the integration, report the failure or open a pull request. Native integration checks should record the exact installed Codex version. CI is configured on macOS for Node 22.19.0, 22.22.2 and 24; a configured matrix is not evidence of completed runs. No Codex executable or provider credentials are required by fixture CI.

Direct stock commands have no Jev control and are visibly marked inactive. `requireJev` refuses that path, including informational stock commands; use `astra-jev-control` for wrapper diagnostics.

Fresh and resumed managed sessions support local synchronous checkpoints. Resume reassesses after each supported tool call; generation leases, live capture verification and generation/token counts are unavailable because stock resume does not expose raw events. Inside a managed TUI, manual model or effort changes pause Jev; explicit enable on Astra or GPT 6.1 Sol restores adaptive control; strict `requireJev` blocks the inactive path. Fork, exec/review, launching with unsupported models, profiles, additional workspace roots, worktrees, external endpoints, permission overrides on resume, and incompatible/future CLI syntax use direct stock execution. Direct launches cannot reactivate Jev later. The scanner routes arguments; Codex validates their meaning.

Native security controls and organizational requirements remain authoritative. Folder trust prompts must be handled by the user. Shell snapshots follow native Codex settings; the package cannot guarantee that endpoint software will never alert. For an external endpoint, local wrapper settings cannot configure the server.
