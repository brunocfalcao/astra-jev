"""Real terminal/native-image smoke test. Synthetic fixtures; no credential output."""
import fcntl
import json
import os
import pathlib
import pty
import re
import select
import signal
import struct
import subprocess
import tempfile
import termios
import time

project = pathlib.Path(__file__).resolve().parent.parent
workspace = pathlib.Path(tempfile.mkdtemp(prefix="astra-jev-tui-proof-"))
(workspace / "sample.txt").write_text("Synthetic terminal fixture. Value 42.\n")
image = workspace / "image.png"
subprocess.run(["magick", "-size", "360x160", "xc:white", "-fill", "black", "-font", "/System/Library/Fonts/Helvetica.ttc", "-pointsize", "38", "-gravity", "center", "-annotate", "0", "ASTRA 42", str(image)], check=True)
master, slave = pty.openpty()
fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 30, 100, 0, 0))
child = subprocess.Popen([str(project / "bin/astra-jev-control.mjs"), "--read-only", "--cwd", str(workspace)], stdin=slave, stdout=slave, stderr=slave, start_new_session=True, env={**os.environ, "NO_COLOR": "1", "TERM": "xterm-256color"})
os.close(slave)
transcript = ""
cursor = 0

def expect(text, timeout=75):
    global transcript, cursor
    deadline = time.monotonic() + timeout
    while text not in transcript[cursor:]:
        if time.monotonic() > deadline:
            raise RuntimeError("Terminal phase timed out: " + text)
        ready, _, _ = select.select([master], [], [], 0.2)
        if ready:
            try:
                chunk = os.read(master, 65536)
            except OSError:
                chunk = b""
            if not chunk:
                raise RuntimeError("Terminal closed before expected phase: " + text)
            transcript += chunk.decode("utf-8", errors="replace")
    end = transcript.index(text, cursor) + len(text)
    content = transcript[cursor:end]
    cursor = end
    return content

def send(line):
    os.write(master, (line + "\n").encode())

result = {"passed": False}
try:
    expect("You > ")
    send("/help")
    expect("/status  Captured effort")
    expect("You > ")
    send("/effort high")
    expect("Next turn: Astra high; Jev paused.")
    expect("You > ")
    send("Read sample.txt once with one native shell tool, then reply exactly TUI_MANUAL_OK.")
    manual = expect("Astra + Jev | completed")
    expect("You > ")
    assert "Astra captured high" in manual
    send("/effort auto")
    expect("Next turn: Jev chooses effort.")
    expect("You > ")
    send("Read sample.txt once with one native shell tool, then reply exactly TUI_AUTO_OK.")
    adaptive = expect("Astra + Jev | completed")
    expect("You > ")
    assert "Jev selected" in adaptive
    send("/image " + str(image))
    expect("Astra receives the image; Jev receives only the image count.")
    expect("You > ")
    send("Read the attached image and report its printed text only.")
    image_turn = expect("Astra + Jev | completed")
    expect("You > ")
    assert "ASTRA 42" in image_turn
    fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack("HHHH", 30, 40, 0, 0))
    os.kill(child.pid, signal.SIGWINCH)
    send("/status")
    expect("Astra captured:")
    expect("You > ")
    send("/quit")
    # Keep draining the PTY while the child restores terminal state and closes
    # native transports. Waiting without reading can block a terminal writer.
    deadline = time.monotonic() + 15
    while child.poll() is None and time.monotonic() < deadline:
        if select.select([master], [], [], 0.1)[0]:
            try:
                transcript += os.read(master, 65536).decode("utf-8", errors="replace")
            except OSError:
                break
    child.wait(timeout=1)
    assert child.returncode == 0
    log_path = re.search(r"Decision log: ([^\r\n]+)", transcript).group(1)
    records = [json.loads(line) for line in pathlib.Path(log_path).read_text().splitlines()]
    turns = [x for x in records if x["type"] == "turn_completed"]
    assert len(turns) == 3
    assert all(x["status"] == "completed" for x in turns)
    selected = [x for x in records if x["type"] == "decision_selected"]
    assert selected[0].get("source") == "manual"
    assert any(x.get("evaluatedModel") == "jev-1.13.0" for x in selected[1:])
    assert not any(x["type"] in ["update_failed", "update_unconfirmed"] for x in records)
    result = {"passed": True, "threadId": turns[0]["threadId"], "turns": len(turns), "widths": [100, 40], "manualEffortCaptured": True, "automaticJevVerified": True, "nativeImageRead": "ASTRA 42", "terminalControls": ["help", "status", "effort", "image", "quit"], "logPath": log_path, "exitCode": child.returncode}
finally:
    if child.poll() is None:
        child.terminate()
        try:
            child.wait(timeout=15)
        except subprocess.TimeoutExpired:
            child.kill()
            child.wait()
    os.close(master)
    (project / "verification/tui.json").write_text(json.dumps(result, indent=2) + "\n")
    (project / "verification/tui-transcript.txt").write_text(transcript)
    print(json.dumps(result))
