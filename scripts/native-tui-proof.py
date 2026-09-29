"""Stock Codex TUI through the private Jev gateway, using a real PTY."""
import fcntl
import json
import os
import pathlib
import pty
import re
import select
import struct
import subprocess
import tempfile
import termios
import time

project = pathlib.Path(__file__).resolve().parent.parent
artifact = "native-tui-effort-notices"
workspace = pathlib.Path(tempfile.mkdtemp(prefix="astra-jev-native-proof-"))
(workspace / "sample.txt").write_text("Synthetic analysis task: A=100, B=100. transfer(id,amount) reads both balances, writes A-amount, writes B+amount, then records id in a dedup set. Two workers can run the same id concurrently, and a crash can happen after any write. Give one concrete duplicate-execution interleaving, one crash/retry counterexample, and the minimum durable atomicity and isolation requirement. No more tools are needed. Finish with NATIVE_TUI_OK.\n")
config_path = project.parent / "astra-jev.json"
config_existed = config_path.exists()
master, slave = pty.openpty()
fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 35, 100, 0, 0))
# Use the existing trusted Herd directory. The fixture stays isolated; do not
# accept a trust prompt or add a test folder to the user's global configuration.
child = subprocess.Popen([str(project / "bin/astra-jev.mjs"), "--sandbox", "read-only", "--cd", str(project.parent), f"Read {workspace / 'sample.txt'} and follow its instructions. Do not inspect other files."], stdin=slave, stdout=slave, stderr=slave, start_new_session=True, env={**os.environ, "TERM": "xterm-256color", "NO_COLOR": "1"})
os.close(slave)
transcript = ""
result = {"passed": False}
try:
    deadline = time.monotonic() + 90
    exited = False
    log_path = None
    status_name = f"tui-{child.pid}"
    records = []
    while time.monotonic() < deadline and child.poll() is None:
        if select.select([master], [], [], 0.2)[0]:
            try:
                data = os.read(master, 65536)
            except OSError:
                break
            if not data:
                break
            transcript += data.decode("utf-8", errors="replace")
            (project / f"verification/{artifact}-transcript.txt").write_text(transcript)
            if b"\x1b[6n" in data:
                os.write(master, b"\x1b[1;1R")
            if b"\x1b[c" in data:
                os.write(master, b"\x1b[?1;2c")
        if not log_path:
            status = subprocess.run([str(project / "bin/astra-jev-control.mjs"), "--status", status_name], capture_output=True, text=True, timeout=10)
            match = re.search(r"Decision log: ([^\r\n]+)", status.stdout)
            if match:
                log_path = match.group(1)
        if log_path:
            records = [json.loads(line) for line in pathlib.Path(log_path).read_text().splitlines()]
        if not exited and any(x["type"] == "turn_completed" for x in records):
            status = subprocess.run([str(project / "bin/astra-jev-control.mjs"), "--status", status_name], capture_output=True, text=True, timeout=10)
            assert status.returncode == 0 and "Jev: responding" in status.stdout
            # Let the native composer regain focus, then use its exit shortcut.
            time.sleep(1)
            os.write(master, b"\x04")
            exited = True
    child.wait(timeout=2)
    assert child.returncode == 0
    turns = [x for x in records if x["type"] == "turn_completed"]
    assert turns and turns[0]["status"] == "completed"
    generations = [x for x in records if x["type"] == "generation_completed"]
    assert len(generations) >= 2 and all(x["verified"] for x in generations)
    assert len(set(x["effort"] for x in generations)) >= 2, "The harder fixture should produce an actual captured effort change"
    assert any(x["type"] == "checkpoint_released" for x in records)
    assert any(x["type"] == "decision_selected" and x.get("evaluatedModel") for x in records)
    assert "NATIVE_TUI_OK" in transcript
    decisions = [x for x in records if x["type"] == "decision_selected" and x.get("evaluatedModel")]
    notices = [x for x in records if x["type"] == "native_tui_effort_notice" and x.get("displayed")]
    pace_notices = [x for x in notices if x.get("outcome") == "pace"]
    assert len(pace_notices) <= 1, "Pace notice repeated within one session"
    plain = re.sub(r"\x1b\[[0-?]*[ -/]*[@-~]", "", transcript)
    rendered = []
    if pace_notices:
        phrase = "Your consumption is above pace"
        assert phrase in plain, "Native TUI did not render the pace notice"
        rendered.append(phrase)
    assert all(x.get("outcome") in ["mode", "unavailable", "pace"] for x in notices)
    result = {"passed": True, "threadId": turns[0]["threadId"], "nativeTuiExit": child.returncode, "generationEfforts": [x["effort"] for x in generations], "checkpointCount": sum(x["type"] == "checkpoint_released" for x in records), "statusQueryVerified": True, "decisionCount": len(decisions), "renderedNotices": rendered, "logPath": log_path, "transport": "WebSocket over owner-only Unix socket; no TCP"}
finally:
    if child.poll() is None:
        child.terminate()
        try:
            child.wait(timeout=10)
        except subprocess.TimeoutExpired:
            child.kill()
            child.wait()
    os.close(master)
    if not config_existed and config_path.exists():
        config_path.unlink()
    (project / f"verification/{artifact}.json").write_text(json.dumps(result, indent=2) + "\n")
    (project / f"verification/{artifact}-transcript.txt").write_text(transcript)
    print(json.dumps(result))
