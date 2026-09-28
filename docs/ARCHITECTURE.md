# Architecture

The launcher reads project JSON and chooses between an owned Codex App Server/TUI session and direct stock execution. User arguments are kept as an argument array; no shell command string is constructed.

Managed sessions use stock Codex over stdio, a WebSocket gateway on an owner-only Unix socket, and a session-scoped MCP PostToolUse hook. The native TUI selects a new or resumed thread before the controller adopts it. Only the exact owned hook receives session-local trust; unrelated hooks retain native trust behavior.

Jev selects Astra effort and a lease of 1, 2, 5 or 10 generations. The controller publishes supported native effort updates and separately observes native capture events. An acknowledgement is not a capture. Distinct raw response IDs advance leases; new prompts and reported failures cause reassessment. Bounded context and typed probability metadata support diagnosis, not a correctness proof.

The gateway owns one thread and forwards native approvals. Other-thread hooks pass through without evaluator access. Disconnects interrupt active work and decline pending requests. Steered input is rejected until the active turn is interrupted. Hosted/no-tool/asynchronous continuations are not universally gated.

Resume lacks the verified stock API's raw-event opt-in. Jev chooses effort per user turn only. Managed resume defaults to an explicit read-only sandbox; the result is checked before accepting the thread and each subsequent turn is pinned. A native client request cannot widen this policy. Opting into `resumePermissions: "codex"` deliberately relinquishes that pin. Fixed and direct modes never attribute their decisions to Jev.

`requireJev` blocks unsupported direct execution and manual effort configurations. At turn start, evaluator failure prevents the model turn. At an active checkpoint, evaluator or publication failure stops the controller and requests native interruption. This cannot roll back work already in flight or extend checkpoint coverage.

Native mode and effort notices are display-only projections through Codex's existing completed-hook renderer. They do not enter model context or execute additional hooks. Status distinguishes live-host evidence from recorded logs. The native footer may remain stale.
