#!/usr/bin/env python3
"""DSH Chat Viewer - read-only local web browser for DeepSeek Harness sessions.

Reads ``<DSH_HOME>/sessions/<workspace>/<session>/session.vN.jsonl.zstd``
directly, in read-only mode, and serves a three pane UI:

    sessions  |  questions of the selected session  |  answer + tool calls

Only the Python standard library is used (http.server + compression.zstd,
Python 3.14+).  Nothing in the DSH home is ever written or locked.

Run:  python server.py            (then open http://127.0.0.1:8766)
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import threading
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlparse

HERE = Path(__file__).resolve().parent
STATIC = HERE / "static"
sys.path.insert(0, str(HERE))

from lib.dsh import (  # noqa: E402
    IMAGE_EXT,
    IMAGE_TYPE,
    Store,
    dsh_home,
    normalize_path,
    preview,
)

CONTENT_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".map": "application/json; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".ico": "image/x-icon",
    ".woff": "font/woff",
    ".woff2": "font/woff2",
    ".ttf": "font/ttf",
    ".otf": "font/otf",
}


def _clip(text: str, limit: int = 200_000) -> str:
    text = str(text or "")
    return text if len(text) <= limit else text[:limit] + "\n… (已截断)"


def _clip_images(images) -> list:
    out = []
    for image in images or []:
        if isinstance(image, dict):
            out.append(image)
        elif isinstance(image, str) and image:
            out.append({"kind": "path", "path": image})
    return out


def chat_json(chat: dict) -> dict:
    return {
        "id": chat.get("id"),
        "title": chat.get("title") or "(无标题)",
        "cwd": chat.get("cwd") or "",
        "workspace": chat.get("workspace") or {},
        "model": chat.get("model") or "",
        "provider": chat.get("provider") or "",
        "created_at": chat.get("created_at") or 0,
        "last_activity_at": chat.get("last_activity_at") or 0,
        "questions": chat.get("questions") or 0,
        "answered": chat.get("answered") or 0,
        "message_count": chat.get("message_count") or 0,
        "open": bool(chat.get("open")),
        "pinned": bool(chat.get("pinned")),
        "archived": bool(chat.get("archived")),
        "parent": chat.get("parent"),
        "origin": chat.get("origin"),
        "depth": chat.get("depth"),
        "agent_preset": chat.get("agent_preset"),
        "tokens": chat.get("tokens") or {},
        "stats": chat.get("stats") or {},
        "error": chat.get("error"),
    }


def question_json(turn: dict) -> dict:
    return {
        "seq": turn.get("seq"),
        "q_id": turn.get("q_id"),
        "q": turn.get("q") or "",
        "q_images": _clip_images(turn.get("q_images")),
        "steer": bool(turn.get("steer")),
        "synthetic": bool(turn.get("synthetic")),
        "ts": turn.get("ts") or 0,
        "preview": turn.get("preview") or "",
        "answer_preview": turn.get("answer_preview") or "",
        "answer_chars": turn.get("answer_chars") or 0,
        "tool_summary": turn.get("tool_summary") or [],
        "open": bool(turn.get("open")),
        "reasoning_chars": turn.get("reasoning_chars") or 0,
        "compactions": len(turn.get("compactions") or []),
        "todos": len(turn.get("todos") or []),
    }


def turn_json(turn: dict) -> dict:
    return {
        "seq": turn.get("seq"),
        "q_id": turn.get("q_id"),
        "q": turn.get("q") or "",
        "q_images": _clip_images(turn.get("q_images")),
        "steer": bool(turn.get("steer")),
        "synthetic": bool(turn.get("synthetic")),
        "ts": turn.get("ts") or 0,
        "answer": turn.get("answer") or "",
        "answer_images": _clip_images(turn.get("answer_images")),
        "reasoning": [
            {"step": r.get("step"), "text": _clip(r.get("text") or "", 120_000)}
            for r in (turn.get("reasoning") or [])
        ],
        "calls": turn.get("calls_payload") or [],
        "tool_summary": turn.get("tool_summary") or [],
        "open": bool(turn.get("open")),
        "end_reason": turn.get("end_reason"),
        "compactions": [
            {
                "seq": c.get("seq"),
                "ts": c.get("ts"),
                "text": _clip(c.get("text") or "", 120_000),
                "summary": preview(c.get("text") or "", 300),
            }
            for c in (turn.get("compactions") or [])
        ],
        "todos": turn.get("todos") or [],
        "notices": turn.get("notices") or [],
        "turn": turn.get("turn"),
    }


class Server(ThreadingHTTPServer):
    """One request per connection; short-lived threads; friendly to a browser burst."""

    daemon_threads = True
    # On Windows SO_REUSEADDR lets a second process bind (and silently steal) a
    # port that is already served.  Keep reuse off there; on POSIX it is what
    # makes quick restarts work.
    allow_reuse_address = os.name != "nt"
    request_queue_size = 256

    def handle_error(self, request, client_address) -> None:
        exc = sys.exc_info()[1]
        if isinstance(exc, (ConnectionResetError, ConnectionAbortedError, BrokenPipeError, TimeoutError)):
            return  # the client went away mid-request: not worth a traceback
        super().handle_error(request, client_address)


class Handler(BaseHTTPRequestHandler):
    server_version = "DshChatViewer/1.0"
    protocol_version = "HTTP/1.0"  # every response carries Content-Length and closes
    store: Store
    allow_any_host = False

    def handle(self) -> None:  # a dropped client must not print a traceback
        try:
            super().handle()
        except (ConnectionResetError, ConnectionAbortedError, BrokenPipeError, TimeoutError):
            pass

    # -- helpers ----------------------------------------------------------
    def _host_ok(self) -> bool:
        if self.allow_any_host:
            return True
        host = (self.headers.get("Host") or "").strip()
        name = host.rsplit(":", 1)[0] if ":" in host else host
        return name.strip("[]").lower() in ("127.0.0.1", "localhost", "::1")

    def _send(self, code: int, body: bytes, ctype: str, *, cache: bool = False) -> None:
        self.close_connection = True
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "max-age=600" if cache else "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Connection", "close")
        self.end_headers()
        try:
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionAbortedError):
            pass

    def _json(self, payload, code: int = 200) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self._send(code, body, "application/json; charset=utf-8")

    def _error(self, code: int, message: str) -> None:
        self._json({"error": message}, code)

    def _static(self, rel: str) -> None:
        rel = unquote(rel)
        target = (STATIC / rel).resolve()
        try:
            target.relative_to(STATIC.resolve())
        except ValueError:
            return self._error(403, "forbidden")
        if not target.is_file():
            return self._error(404, "not found")
        ctype = CONTENT_TYPES.get(target.suffix.lower(), "application/octet-stream")
        cacheable = target.suffix.lower() in {
            ".woff", ".woff2", ".ttf", ".otf", ".png", ".jpg", ".jpeg",
            ".gif", ".webp", ".ico", ".svg", ".avif",
        }
        self._send(200, target.read_bytes(), ctype, cache=cacheable)

    def _serve_image(self, path: Path) -> None:
        try:
            if not path.is_file():
                raise OSError
            size = path.stat().st_size
        except OSError:
            return self._json({"error": "missing", "path": str(path)}, 404)
        ext = path.suffix.lower()
        if ext not in IMAGE_EXT:
            return self._error(403, "only image files can be served")
        if size > 40 * 1024 * 1024:
            return self._error(413, "image too large")
        body = path.read_bytes()
        ctype = IMAGE_TYPE.get(ext, "application/octet-stream")
        self.close_connection = True
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "max-age=600")
        self.send_header("X-Content-Type-Options", "nosniff")
        if ext == ".svg":
            self.send_header("Content-Security-Policy", "sandbox")
        self.send_header("Connection", "close")
        self.end_headers()
        try:
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionAbortedError):
            pass

    def _file(self, raw: str) -> None:
        """Serve a local image referenced by a message (read-only, images only)."""
        if not raw:
            return self._error(400, "missing path")
        self._serve_image(Path(normalize_path(raw)))

    def _attachment(self, sid: str, attachment_id: str) -> None:
        path = self.store.find_attachment(sid, attachment_id)
        if path is None:
            return self._json({"error": "attachment not found", "id": attachment_id}, 404)
        self._serve_image(path)

    # -- routing ----------------------------------------------------------
    def do_GET(self) -> None:  # noqa: N802
        parsed = urlparse(self.path)
        path = unquote(parsed.path)
        query = parse_qs(parsed.query)

        def q1(name: str, default: str = "") -> str:
            return (query.get(name) or [default])[0]

        if path in ("/", "/index.html"):
            return self._static("index.html")
        if path.startswith("/static/"):
            return self._static(path[len("/static/"):])
        if path == "/favicon.ico":
            return self._error(404, "not found")
        if not self._host_ok():
            return self._error(403, "forbidden host header")

        try:
            if path == "/file":
                return self._file(q1("path"))
            if path == "/attachment":
                return self._attachment(q1("sid"), q1("id"))

            if path == "/api/meta":
                return self._json(self.store.meta())

            if path == "/api/chats":
                return self._json({"chats": [chat_json(c) for c in self.store.chats()]})

            if path == "/api/search":
                term = q1("q").strip()
                if not term:
                    return self._json({"results": [], "term": ""})
                scope = q1("scope", "all")
                sid = q1("sid") or None
                try:
                    limit = max(1, min(500, int(q1("limit", "300"))))
                except ValueError:
                    limit = 300
                return self._json({
                    "term": term,
                    "results": self.store.search(term, sid, scope, limit),
                })

            parts = [p for p in path.split("/") if p]
            # /api/chats/<sid>/questions
            if len(parts) == 4 and parts[:2] == ["api", "chats"] and parts[3] == "questions":
                sid = parts[2]
                chat = self.store.chat(sid)
                if chat is None:
                    return self._error(404, "unknown session")
                scope = q1("scope", "all")
                term = q1("q").strip().casefold()
                items = []
                for turn in chat.get("turns") or []:
                    if term:
                        hay = ((turn.get("q") or "") + "\n" + (turn.get("answer") or "")).casefold()
                        if scope == "q":
                            hay = (turn.get("q") or "").casefold()
                        elif scope == "a":
                            hay = (turn.get("answer") or "").casefold()
                        if term not in hay:
                            continue
                    items.append(question_json(turn))
                return self._json({
                    "chat": chat_json(chat),
                    "total": len(chat.get("turns") or []),
                    "questions": items,
                })

            # /api/turn/<sid>/<seq>
            if len(parts) == 4 and parts[:2] == ["api", "turn"]:
                sid = parts[2]
                try:
                    seq = int(parts[3])
                except ValueError:
                    return self._error(400, "bad turn sequence")
                chat = self.store.chat(sid)
                if chat is None:
                    return self._error(404, "unknown session")
                turn = self.store.turn(sid, seq)
                if turn is None:
                    return self._error(404, "unknown turn")
                payload = {"chat": chat_json(chat)}
                payload.update(turn_json(turn))
                payload["model"] = chat.get("model") or ""
                payload["workspace"] = chat.get("workspace") or {}
                payload["tokens"] = chat.get("tokens") or {}
                return self._json(payload)

            return self._error(404, "not found")
        except Exception as exc:  # keep the UI alive, report the failure
            if os.environ.get("DSCV_VERBOSE"):
                import traceback
                traceback.print_exc()
            return self._error(500, f"{type(exc).__name__}: {exc}")

    def log_message(self, fmt: str, *args) -> None:  # quiet by default
        if os.environ.get("DSCV_VERBOSE"):
            sys.stderr.write("%s - %s\n" % (self.address_string(), fmt % args))


def main() -> int:
    try:  # keep Chinese diagnostics readable in a cp932 console
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
        sys.stderr.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass

    if sys.version_info < (3, 14):
        print(
            "DSH Chat Viewer requires Python 3.14+ (standard library compression.zstd).\n"
            f"Current interpreter: {sys.version.split()[0]} ({sys.executable})",
            file=sys.stderr,
        )
        return 2

    ap = argparse.ArgumentParser(description="Read-only web viewer for DeepSeek Harness sessions")
    ap.add_argument("--home", help="DSH home directory (default: %%USERPROFILE%%\\.dsh or $DSH_HOME)")
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=8766)
    ap.add_argument("--no-open", action="store_true", help="do not open a browser window")
    args = ap.parse_args()

    home = dsh_home(args.home)
    if not home.is_dir():
        print(f"DSH home not found: {home}", file=sys.stderr)
        print("Use --home to point at the directory containing sessions/ and storages/.", file=sys.stderr)
        return 2

    store = Store(home)
    try:
        store.ensure()
    except Exception as exc:
        print(f"failed to read sessions: {type(exc).__name__}: {exc}", file=sys.stderr)
        return 2

    Handler.store = store
    Handler.allow_any_host = args.host not in ("127.0.0.1", "localhost", "::1")

    try:
        httpd = Server((args.host, args.port), Handler)
    except OSError as exc:
        print(f"无法监听 {args.host}:{args.port} — 端口可能已被占用（{exc}）", file=sys.stderr)
        print("先停掉占用该端口的旧进程，或用 --port 换一个端口。", file=sys.stderr)
        return 3

    url = f"http://{args.host}:{args.port}/"
    meta = store.meta()
    print(f"DSH Chat Viewer  ->  {url}")
    print(f"  home:  {home}")
    print(f"  {meta['sessions']} sessions, {meta['questions']} questions, {meta['workspaces']} workspaces")
    print("  Ctrl+C to stop")
    if not args.no_open:
        threading.Timer(1.0, lambda: webbrowser.open(url)).start()
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nbye")
    finally:
        httpd.server_close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
