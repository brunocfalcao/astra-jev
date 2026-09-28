"""Native resume selection through the unchanged Codex TUI, with real Jev."""
import fcntl
import json
import os
import pathlib
import pty
import re
import select
import struct
import subprocess
import termios
import time

project = pathlib.Path(__file__).resolve().parent.parent
source = json.loads((project / 'verification/native-tui-effort-notices.json').read_text())
thread_id = source['threadId']
config_path = project.parent / 'astra-jev.json'
config_existed = config_path.exists()

def run_case(args, picker=False, turn=False):
    master, slave = pty.openpty()
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 35, 100, 0, 0))
    child = subprocess.Popen([str(project / 'bin/astra-jev.mjs'), '--cd', str(project.parent), *args], stdin=slave, stdout=slave, stderr=slave, start_new_session=True, env={**os.environ, 'TERM': 'xterm-256color', 'NO_COLOR': '1', 'ASTRA_JEV_PRIVACY_ACK': '1'})
    os.close(slave)
    transcript = ''
    records = []
    log_path = None
    stopped = False
    try:
        deadline = time.monotonic() + 55
        while time.monotonic() < deadline and child.poll() is None:
            if select.select([master], [], [], 0.2)[0]:
                try: data = os.read(master, 65536)
                except OSError: break
                transcript += data.decode('utf-8', errors='replace')
                if b'\x1b[6n' in data: os.write(master, b'\x1b[1;1R')
                if b'\x1b[c' in data: os.write(master, b'\x1b[?1;2c')
            if not log_path:
                match = re.search(r'Decision log: ([^\r\n]+)', transcript)
                if match: log_path = match.group(1)
            if log_path:
                records = [json.loads(line) for line in pathlib.Path(log_path).read_text().splitlines()]
            selected = [r for r in records if r['type'] == 'session_opened']
            if selected: assert selected[0]['threadId'] == thread_id, 'Unexpected thread selected; no prompt sent'
            ready = any(r['type'] == 'turn_completed' for r in records) if turn else bool(selected)
            if picker: ready = any(r.get('method') == 'thread/list' for r in records) and 'Resume' in transcript
            if ready and not stopped:
                if picker or not turn:
                    if picker: assert not selected
                    child.terminate()
                else:
                    time.sleep(2)
                    os.write(master, b'/quit')
                    time.sleep(1)
                    os.write(master, b'\r')
                stopped = True
                if not turn and not picker:
                    time.sleep(0.5)
                    os.write(master, b"\r")
        child.wait(timeout=3)
        assert stopped, 'Native resume did not reach the expected state'
        if turn: assert child.returncode == 0
        if turn:
            assert any(r['type'] == 'decision_selected' and r.get('evaluatedModel') == 'jev-1.13.0' for r in records)
            assert any(r['type'] == 'turn_completed' and r['status'] == 'completed' for r in records)
            assert any(r['type'] == 'native_tui_effort_notice' for r in records)
            assert 'RESUME_OK' in transcript
            assert selected[0]['sandbox'] == 'readOnly'
            assert 'PER-TURN' in transcript
        return {'args': args, 'passed': True, 'threadId': None if picker else thread_id, 'mode': None if picker else selected[0]['mode'], 'exitCode': child.returncode, 'logPath': log_path, 'jevDecisions': sum(r['type'] == 'decision_selected' for r in records)}
    finally:
        if child.poll() is None:
            child.terminate()
            try: child.wait(timeout=5)
            except subprocess.TimeoutExpired: child.kill(); child.wait()
        os.close(master)
        (project / 'verification/resume-cli-last-transcript.txt').write_text(transcript)

try:
    results = [run_case(['resume', thread_id, 'Do not use tools. Reply exactly RESUME_OK.'], turn=True)]
    results.append(run_case(['resume', '--last']))
    results.append(run_case(['resume'], picker=True))
    report = {'passed': True, 'cases': results}
    (project / 'verification/resume-cli.json').write_text(json.dumps(report, indent=2) + '\n')
    print(json.dumps(report))
finally:
    if not config_existed and config_path.exists(): config_path.unlink()
