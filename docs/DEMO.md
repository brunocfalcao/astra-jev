# One-minute beta walkthrough

This is a demonstration script, not a measured savings claim. Use a disposable project containing only synthetic material. Do not record keys, private project names or session histories.

1. Show `astra-jev-control setup` and its privacy explanation. Complete key setup before recording; never record secret input.
2. Run `astra-jev --sandbox read-only` in the project. Show the automatically created project JSON, then the initial Jev effort choice on the first turn.
3. Ask Astra to read a small fixture and assess a concurrency bug. Show a real captured effort notice if one occurs. Do not present a scripted label as a live decision or promise a specific effort.
4. Open the printed `astra-jev-control --status tui-...` command in another terminal. Explain selected versus captured effort.
5. Exit and run `astra-jev resume`. Show the native picker and selected effort; use status to inspect PER-TURN mode and native Codex permissions. Explain that mid-turn capture is unavailable on resumed threads.
6. Use `$astra-jev show this project’s settings` to demonstrate the automatically installed configuration skill.
7. Show a stock informational command such as `astra-jev --version`: Jev is explicitly INACTIVE. Explain `requireJev` for users who prefer an error over fallback.

Suggested closing: “Stock Codex, visible Jev decisions, explicit limits. macOS beta; feedback and synthetic reproductions welcome.”
