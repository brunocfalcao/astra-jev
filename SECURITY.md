# Security policy

## Reporting

Report sensitive findings through [GitHub private vulnerability reporting](https://github.com/brunocfalcao/astra-jev/security/advisories/new). Do not post keys, private source, user logs or exploitation details in public issues. If the private channel is unavailable, open a public issue containing only “Please enable private vulnerability reporting” and wait before sharing details. No response-time promise is made for this beta.

Private vulnerability reporting is enabled for this repository. Maintainers should verify it remains available before each release.

## Supported scope

The macOS beta and its documented Codex version are the validation target. No independent security certification is claimed. We welcome bounded reports about permission enforcement, credential disclosure, private IPC, argument handling, package contents and evaluator data exposure. Test only systems and data you own or have authorization to assess.

## Boundaries

The wrapper does not patch Codex, disable endpoint protection, expose TCP listeners, install a daemon or bypass native approval/trust controls. IPC directories and sockets are owner-only. Unknown Codex options are passed to stock Codex with an explicit Jev-inactive notice; `requireJev` can prohibit fallback. Filesystem, network and approval policy are owned by Codex for fresh and resumed sessions. Astra-Jev forwards native permissions without introducing its own policy. Project JSON is trusted configuration, not a security boundary against the account that owns the project.

Jev receives selected context over TLS. Redaction is imperfect; see PRIVACY.md. Hook failures interrupt the managed turn, but an interruption cannot undo a generation that already started or guarantee coverage of tools that do not expose checkpoints. Dependencies and published artifacts require continuing review.
