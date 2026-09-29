# Releasing the macOS beta

Repository target: https://github.com/brunocfalcao/astra-jev

## Local release gates

1. Review changed code and notices; ensure no credentials, private histories or machine-specific artifacts are in the source release.
2. Run `npm ci --ignore-scripts`, `npm run check`, `npm run pack:check`, and `npm run test:install` on macOS. The install check uses a separate prefix, exercises both commands and reinstall/uninstall, and preserves project settings. Verify the bundled skill installs, updates owned content, preserves custom copies, and can use the configuration CLI. It does not substitute for a clean-machine native run.
3. Run an opt-in native check using the installed stock Codex and synthetic data; record its exact version. Verify fresh LOW/HIGH capture, status, explicit resume with mid-turn effort updates, picker/last selection, native permission preservation, including a configured read-only negative control, concise effort notices, interruption and process cleanup. Keep raw logs private. No live provider calls run in PR CI.
4. Verify the GitHub macOS CI matrix passes and perform a clean-Mac installation with real Codex authentication. Record what was tested and what remains limited.
5. Review the MIT license and third-party notices, version/changelog, package contents and checksum. Do not state that a legal or independent security audit occurred.

## Publication prerequisites

The source beta is public. Before an installable release, the maintainer must verify repository access, review the release source and commit, verify GitHub private vulnerability reporting and the private report link, and choose GitHub release-only distribution or an available npm package name. The repository and npm name are not proven available merely because metadata names them. No publishing workflow or npm token is installed by this project.

## Build a reviewable artifact

After the gates pass, run `npm pack --ignore-scripts --pack-destination artifacts`. Inspect the archive and compute its SHA-256. Publish only the reviewed versioned archive and release notes, never the entire local working directory. The package checker enforces an explicit file allowlist and checks for known private-content patterns; it is not a universal secret detector.

With explicit owner authorization, create the release commit/tag and GitHub release. If publishing to npm, verify package ownership first and use the `beta` dist-tag; do not make this experimental build the stable `latest` release accidentally. Enable provenance through the chosen trusted publishing process when configured. Publication remains a separate action from preparing the package.

## Rollback

Install the previous reviewed archive. Before launching rc.1, remove the new `effortAdjustment` field from a project file; preserve its other settings. Existing processes keep their loaded code; exit and restart them. Compatibility or permission failures must stop a managed launch rather than silently relaxing its policy.
