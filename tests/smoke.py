#!/usr/bin/env python3
"""HTTP smoke tests for DSH Chat Viewer.

Starts the real server against a synthetic DSH home, then checks the JSON API,
the image-only endpoint, and the Host header guard.

    C:\\pixi_env\\.pixi\\envs\\default\\python.exe tests\\smoke.py
"""

from __future__ import annotations

import http.client
import json
import socket
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from urllib.parse import quote
from urllib.request import Request, urlopen

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(ROOT))

try:  # keep Chinese test output readable in a cp932 console
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

from fixture import SID, write_session  # noqa: E402

PNG = (
    b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x00\x00\x01\x00\x00\x00\x01"
    b"\x08\x06\x00\x00\x00\x1f\x15\xc4\x89\x00\x00\x00\nIDATx\x9cc\x00\x01"
    b"\x00\x00\x05\x00\x01\r\n-\xb4\x00\x00\x00\x00IEND\xaeB`\x82"
)

failures = 0


def check(name: str, ok: bool, detail: str = "") -> None:
    global failures
    print(f"{'PASS' if ok else 'FAIL'}  {name}" + (f"  — {detail}" if detail else ""))
    if not ok:
        failures += 1


def free_port() -> int:
    sock = socket.socket()
    sock.bind(("127.0.0.1", 0))
    port = sock.getsockname()[1]
    sock.close()
    return port


def get(base: str, path: str, timeout: float = 10.0) -> tuple[int, bytes, str]:
    req = Request(base + path, headers={"Accept": "*/*"})
    try:
        with urlopen(req, timeout=timeout) as response:
            return response.status, response.read(), response.headers.get("Content-Type", "")
    except Exception as exc:
        code = getattr(exc, "code", 0) or getattr(getattr(exc, "response", None), "status", 0)
        return code, b"", ""


def get_json(base: str, path: str):
    status, body, _ = get(base, path)
    if status != 200:
        return status, None
    return status, json.loads(body.decode("utf-8"))


def main() -> int:
    with tempfile.TemporaryDirectory() as tmp:
        home = Path(tmp)
        write_session(home)
        image = home / "pic.png"
        image.write_bytes(PNG)

        port = free_port()
        base = f"http://127.0.0.1:{port}"
        server = ROOT / "server.py"
        proc = subprocess.Popen(
            [sys.executable, str(server), "--home", str(home), "--port", str(port), "--no-open"],
            cwd=str(ROOT),
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )
        try:
            ready = False
            for _ in range(100):
                status, data = get_json(base, "/api/meta")
                if status == 200 and data:
                    ready = True
                    break
                time.sleep(0.1)
            check("服务器启动", ready)
            if not ready:
                out, err = proc.communicate(timeout=2)
                print(out[-2000:])
                print(err[-2000:])
                return 3

            status, meta = get_json(base, "/api/meta")
            check("meta", status == 200 and meta.get("sessions") == 1 and meta.get("questions") == 2,
                  json.dumps(meta, ensure_ascii=False))

            status, chats = get_json(base, "/api/chats")
            chat = (chats or {}).get("chats", [{}])[0]
            check("chats", status == 200 and chat.get("title") == "测试会话"
                  and chat.get("questions") == 2 and chat.get("pinned") is True)

            status, questions = get_json(base, f"/api/chats/{quote(SID)}/questions")
            check("questions", status == 200 and len(questions.get("questions", [])) == 2)

            status, filtered = get_json(
                base, f"/api/chats/{quote(SID)}/questions?q={quote('第二轮')}&scope=q"
            )
            check("question filter", status == 200 and len(filtered.get("questions", [])) == 1)

            status, turn = get_json(base, f"/api/turn/{quote(SID)}/2")
            check("turn", status == 200 and turn.get("q") == "第一轮问题：列一下文件。")
            check("answer", "第一轮回答的第一段。" in (turn.get("answer") or "")
                  and "第一轮回答的第二段。" in (turn.get("answer") or ""))
            pwsh = next((c for c in turn.get("calls", []) if c.get("name") == "pwsh"), None)
            check("pwsh tool result", bool(pwsh) and pwsh["result"]["exit_code"] == 1
                  and pwsh["job"]["duration_ms"] == 100)
            ask = next((c for c in turn.get("calls", []) if c.get("name") == "ask_user_question"), None)
            check("ask custom answer", bool(ask)
                  and ask["questions"][1]["custom"] == "自定义回答")

            status, search = get_json(base, f"/api/search?q={quote('第二轮')}&limit=10")
            check("search", status == 200 and len(search.get("results", [])) == 1)

            status, body, ctype = get(base, "/file?path=" + quote(str(image)))
            check("image endpoint", status == 200 and ctype.startswith("image/png") and body == PNG)

            status, _, _ = get(base, "/file?path=" + quote(str(home / "storages" / "workspace.json")))
            check("image endpoint rejects non-image", status == 403, str(status))

            status, _, _ = get(base, "/static/app.js")
            check("static", status == 200)

            conn = http.client.HTTPConnection("127.0.0.1", port, timeout=5)
            conn.request("GET", "/api/chats", headers={"Host": "evil.example.com"})
            response = conn.getresponse()
            response.read()
            check("Host guard", response.status == 403, str(response.status))
            conn.close()
        finally:
            proc.terminate()
            try:
                proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                proc.kill()

    print("\nALL PASS" if failures == 0 else f"\n{failures} FAILED")
    return 0 if failures == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
