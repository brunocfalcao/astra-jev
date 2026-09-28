# Privacy and credentials

## Before the first Jev request

The CLI asks you to acknowledge this data flow before adaptive use or its Jev health check. The acknowledgment is stored at `~/.config/astra-jev/privacy-v1.json` with owner-only permissions. Automation can explicitly acknowledge it with `ASTRA_JEV_PRIVACY_ACK=1`; do so only after reviewing this document. Fixed and direct-stock modes do not call Jev. Low-level developer APIs and live proof scripts are not the CLI onboarding boundary.

## Data sent to TypeSafe

Jev receives bounded text: the original/latest request, up to three earlier prompts, public assistant notes, the current public plan, and six recent tool calls/results. Truncated outputs may retain short diagnostic excerpts. Request bodies are capped at 128 KiB. Hidden reasoning, encrypted blocks and image content are excluded; image counts may be included.

Known keys and common credential patterns are redacted before truncation. **Redaction is best effort.** It cannot recognize every secret or remove arbitrary confidential business text. Do not use Jev on data you are not authorized to send to TypeSafe. TypeSafe's current service terms, retention practices and billing apply; this project does not set those policies. See [TypeSafe documentation](https://docs.typesafe.ai/).

The wrapper makes no separate analytics calls. Codex retains its normal account, tools, network behavior and history. This document does not describe or override OpenAI's own data policies.

Switching a managed conversation to a non-Astra model suspends Jev. Those turns do not call the evaluator, and their prompts and tool outputs are not added to its live context. Returning to Astra starts fresh evaluator context; Codex keeps the conversation. If you later reopen saved history in a new managed session, the normal resumed-history policy applies. A model selection made during an active turn applies after that turn finishes.

## Key setup

Prefer `astra-jev-control setup` or a secret manager that provides `TYPESAFE_API_KEY`. Setup uses hidden input and writes `~/.config/astra-jev/credentials` with owner-only permissions, without overwriting an existing file. It never prints the value. The key is excluded from Codex child environments, wrapper arguments and decision logs.

Lookup order: environment, `~/.config/astra-jev/credentials`, then legacy `~/.credentials` and `~/Herd/.credentials/credentials`. Legacy files are parsed as data; no shell evaluation occurs. Their existing permissions are not changed. Never put a key in project JSON, an issue, screenshot or terminal transcript.

## Local records and removal

Decision metadata is stored under `~/.local/share/astra-jev/logs/` in private files. It includes thread/response IDs, effort, probability/confidence metadata, capture evidence, counts, timing and usage. It omits prompt/tool bodies. Codex's own history is separate and may contain those bodies. Metadata, paths and thread IDs can still be sensitive; inspect reports before sharing them.

Uninstall does not erase data. To revoke local acknowledgment, remove only `~/.config/astra-jev/privacy-v1.json`; the next managed launch asks again. To remove this utility's saved key, remove only `~/.config/astra-jev/credentials`; revoke the provider key separately if needed. After stopping your wrapper processes, app-owned decision logs and run sockets under `~/.local/share/astra-jev/` may be removed. Project `astra-jev.json` files can be removed individually. Preserve shared credential stores and Codex history unless you independently intend to remove them.
