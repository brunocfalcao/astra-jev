# Contributing

Start with a small issue describing observed behavior, expected behavior and a synthetic reproduction. Do not attach credentials or raw private sessions. Security findings follow SECURITY.md.

Use macOS and Node 22.19 or newer. Install with `npm ci --ignore-scripts`; run `npm run check`, `npm run pack:check`, and `npm run test:install`. These checks use local fixtures and do not require Codex or Jev credentials. Native integration changes also need an opt-in real Codex/Jev run using the installed stock Codex with synthetic data; record its exact version and report this separately from fixture tests.

Keep patches focused. Preserve stock Codex compatibility, permission enforcement, argument boundaries, owner-only IPC and distinctions between selected/published/captured effort. Cover failure, interruption, cancellation, resumed sessions and unrelated-thread isolation when changing these boundaries. Never claim token savings or quality improvements from a connectivity test.

By contributing, you agree that your contribution is provided under the project's MIT license. Include provenance and required notices for third-party material. Do not add generated logs, private project settings, credentials, local paths or packaged binaries to a pull request.
