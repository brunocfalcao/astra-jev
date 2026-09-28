# Architecture

The launcher reads project JSON and chooses between an owned Codex App Server/TUI session and direct stock execution. User arguments are kept as an argument array; no shell command string is constructed.

Managed sessions use stock Codex over stdio, a WebSocket gateway on an owner-only Unix socket, and a session-scoped MCP PostToolUse hook. The native TUI selects a new or resumed thread before the controller adopts it. Only the exact owned hook receives session-local trust; unrelated hooks retain native trust behavior.

Jev selects Astra effort and a lease of 1, 2, 5 or 10 generations. The controller publishes supported native effort updates and separately observes native capture events. An acknowledgement is not a capture. Distinct raw response IDs advance leases; new prompts and reported failures cause reassessment. Bounded context and typed probability metadata support diagnosis, not a correctness proof.

The gateway owns one thread and forwards native approvals. Other-thread hooks pass through without evaluator access. Disconnects interrupt active work and decline pending requests. Steered input is rejected while Astra is managed until the active turn is interrupted. Hosted/no-tool/asynchronous continuations are not universally gated.

Native model selection updates the session's Jev mode. A non-Astra turn passes its model, effort and collaboration settings through without evaluation; native permission settings pass through unchanged. The attached checkpoint relay returns immediately without retaining content, and its activity notices are hidden while inactive. Returning to Astra restores the original adaptive/per-turn/fixed policy with cleared evaluator context and effort-capture state. In-flight turns keep their current controller until completion. `requireJev` rejects non-Astra selection before forwarding it.

Resume lacks the verified stock API's raw-event opt-in. Jev chooses effort per user turn only. Codex owns filesystem, network, approval and workspace settings. The wrapper does not inject permission defaults or reapply startup permissions on later turns, settings changes or reconnects. Legacy `resumePermissions` and `noAltScreen` project fields are ignored. Shell-snapshot and display defaults belong to Codex. Fixed and direct modes never attribute their decisions to Jev.

`requireJev` blocks unsupported direct execution and manual effort configurations. At turn start, evaluator failure prevents the model turn. At an active checkpoint, evaluator or publication failure stops the controller and requests native interruption. This cannot roll back work already in flight or extend checkpoint coverage.

Native effort and model-transition notices are display-only projections through Codex's existing completed-hook renderer. They do not enter model context or execute additional hooks. Status distinguishes live-host evidence from recorded logs. The native footer may remain stale.

The bundled `$astra-jev` skill installs during setup or managed launch. Its installer updates only an unchanged package-owned copy and preserves custom skills. Configuration commands validate project settings before an atomic file replacement; they do not contact a provider. No npm lifecycle scripts run.
