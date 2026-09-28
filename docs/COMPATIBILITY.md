# Compatibility

| Component | Beta scope |
| --- | --- |
| Operating system | macOS; other platforms are not supported by this package release |
| Node | 22.19+ required; local validation uses 22.22.2 |
| Codex | Stock 0.157.1; managed sessions reject an unverified protocol version |
| Model | `gpt-6-astra`, account availability required |
| Evaluator | TypeSafe `jev-1.13.0`, separate API key |
| IPC | Unix sockets only, owner-only directories and sockets |

Do not upgrade the compatibility pin without inspecting native schemas/source and rerunning permission, capture, checkpoint, resume and cancellation checks. CI is configured on macOS for Node 22.19.0, 22.22.2 and 24; a configured matrix is not evidence of completed runs. No Codex executable or provider credentials are required by fixture CI.

Direct stock commands can run outside the managed compatibility pin. They have no Jev control and are visibly marked inactive. `requireJev` refuses that path, including informational stock commands; use `astra-jev-control` for wrapper diagnostics.

Fresh managed sessions support local synchronous checkpoints. Resume supports per-turn choice only. Fork, exec/review, other models, profiles, additional workspace roots, worktrees, external endpoints, permission overrides on resume, and incompatible/future CLI syntax use direct stock execution. The scanner routes arguments; Codex validates their meaning.

Native security controls and organizational requirements remain authoritative. Folder trust prompts must be handled by the user. Snapshot disabling is a process-local precaution, not proof that endpoint software will never alert. For an external endpoint, local wrapper settings cannot configure the server.
