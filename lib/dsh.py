#!/usr/bin/env python3
"""Read DeepSeek Harness (DSH) session logs.

DSH stores each session as an append-only JSONL log, optionally compressed as a
concatenation of independent Zstandard frames.  A log is event-sourced:

    session header
    turn/start, step/start, system/message, user/message, assistant/message,
    tool/call, tool/result, step/end, turn/end, ...

This module turns that stream into the same (question, answer, tool calls)
shape the Hermes viewer uses.  It never writes to the DSH home directory.

Python 3.14's standard library provides ``compression.zstd``.  No third-party
package is required.
"""

from __future__ import annotations

import hashlib
import io
import json
import os
import re
import threading
from dataclasses import dataclass
from pathlib import Path
from typing import Any

try:  # Python 3.14+
    from compression import zstd
except Exception:  # pragma: no cover - a clear error is raised when needed
    zstd = None


# ---------------------------------------------------------------------------
# constants
# ---------------------------------------------------------------------------

ZSTD_READ_CHUNK = 1 << 20
ZSTD_MAGIC = b"\x28\xb5\x2f\xfd"
SESSION_FILE_RE = re.compile(r"^session(?:\.v(\d+))?\.jsonl(\.zstd)?$")

IMAGE_EXT = {".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".svg", ".ico", ".avif"}
IMAGE_TYPE = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".bmp": "image/bmp",
    ".svg": "image/svg+xml",
    ".ico": "image/x-icon",
    ".avif": "image/avif",
}
MIME_EXT = {
    "image/png": ".png",
    "image/jpeg": ".jpg",
    "image/jpg": ".jpg",
    "image/webp": ".webp",
    "image/gif": ".gif",
    "image/bmp": ".bmp",
    "image/svg+xml": ".svg",
    "image/avif": ".avif",
}

EXT_LANG = {
    ".py": "python", ".pyw": "python", ".js": "javascript", ".mjs": "javascript",
    ".cjs": "javascript", ".ts": "typescript", ".tsx": "typescript",
    ".jsx": "javascript", ".json": "json", ".jsonl": "json", ".md": "markdown",
    ".markdown": "markdown", ".yaml": "yaml", ".yml": "yaml", ".sh": "bash",
    ".bash": "bash", ".zsh": "bash", ".bat": "dos", ".cmd": "dos",
    ".ps1": "powershell", ".psm1": "powershell", ".html": "xml", ".htm": "xml",
    ".xml": "xml", ".css": "css", ".scss": "scss", ".sql": "sql", ".toml": "ini",
    ".ini": "ini", ".cfg": "ini", ".c": "c", ".h": "c", ".cc": "cpp",
    ".cpp": "cpp", ".hpp": "cpp", ".cs": "csharp", ".java": "java", ".rs": "rust",
    ".go": "go", ".rb": "ruby", ".php": "php", ".diff": "diff", ".patch": "diff",
    ".txt": "plaintext", ".csv": "plaintext", ".tsv": "plaintext", ".log": "plaintext",
    ".ipynb": "json", ".svg": "xml", ".vue": "xml", ".r": "r", ".lua": "lua",
}

MEDIA_RE = re.compile(r"MEDIA:\s*([^\s`\"'<>|]+)", re.I)
Q_IMAGE_RE = re.compile(r"@image:\s*([^\s\]\)]+)", re.I)
MD_IMAGE_RE = re.compile(r"!\[[^\]]*\]\(\s*(<[^>]+>|[^)\s]+)(?:\s+[\"'][^\"']*[\"'])?\s*\)")
HTML_IMG_RE = re.compile(r"<img\b[^>]*\bsrc\s*=\s*[\"']([^\"']+)[\"']", re.I)
SCREENSHOT_RE = re.compile(r"\[screenshot\]", re.I)

EXIT_RE = re.compile(r"\n?\[exit code:\s*(-?\d+)\]\s*$", re.I)
ANSI_RE = re.compile(r"\x1b\[[0-9;?]*[ -/]*[@-~]")

FILE_WRAPPER_RE = re.compile(
    r"^\s*<path>(.*?)</path>\s*<type>(.*?)</type>\s*<content>\s*(.*?)\s*</content>\s*(.*)$",
    re.S,
)
FILE_FOOTER_RE = re.compile(
    r"\((?:Showing lines \d+-\d+ of \d+\.\s*Use offset=\d+ to continue\.|"
    r"End of file - total \d+ lines\.?)\)\s*$",
    re.I,
)
LINE_NO_RE = re.compile(r"^\s*(\d+):\s?(.*)$")

TOOL_RESULT_TRUNC = 160_000
ARG_TRUNC = 60_000
CALL_NOTE_TRUNC = 2_000

# Tools whose arguments contain a big code / command blob worth highlighting.
CODE_ARG = {
    "pwsh": ("command", "powershell"),
    "bash": ("command", "bash"),
    "terminal": ("command", "bash"),
    "execute_code": ("code", "python"),
}
PATH_ARG = {
    "read": "file_path", "read_file": "file_path", "write": "file_path",
    "write_file": "file_path", "edit": "file_path", "patch": "file_path",
    "apply_patch": "file_path", "read_image_file": "file_path",
    "list_directory": "path", "glob": "path", "grep": "path",
}
SUMMARY_KEYS = (
    "description", "file_path", "path", "pattern", "query", "url", "name",
    "queries", "prompt", "skill", "command", "label",
)


# ---------------------------------------------------------------------------
# small helpers
# ---------------------------------------------------------------------------


def normalize_path(raw: str | None) -> str:
    """Accept ``C:\\x``, ``C:/x``, ``file:///C:/x``, ``MEDIA:C:\\x``."""
    p = str(raw or "").strip().strip("\"'`")
    p = re.sub(r"^MEDIA:\s*", "", p, flags=re.I)
    if p.lower().startswith("file:///"):
        p = p[8:]
    if re.match(r"^/[A-Za-z]:", p):  # /C:/x
        p = p[1:]
    return p


def is_image_path(path: str | None) -> bool:
    return Path(normalize_path(path)).suffix.lower() in IMAGE_EXT


def lang_from_path(path: str | None) -> str:
    return EXT_LANG.get(Path(normalize_path(path)).suffix.lower(), "plaintext")


def preview(text: str | None, limit: int = 90) -> str:
    flat = " ".join(str(text or "").split())
    return flat if len(flat) <= limit else flat[:limit] + "..."


def _json_text(value: Any) -> str:
    try:
        return json.dumps(value, ensure_ascii=False, indent=2)
    except Exception:
        return str(value)


def _clip(text: str, limit: int) -> tuple[str, bool]:
    text = str(text or "")
    if len(text) <= limit:
        return text, False
    return text[:limit] + "\n...", True


def _dedupe(items: list[dict]) -> list[dict]:
    out: list[dict] = []
    seen: set[str] = set()
    for item in items:
        key = json.dumps(item, ensure_ascii=False, sort_keys=True)
        if key in seen:
            continue
        seen.add(key)
        out.append(item)
    return out


# ---------------------------------------------------------------------------
# zstd / JSONL
# ---------------------------------------------------------------------------


class DshError(RuntimeError):
    pass


def _read_zstd_stream(handle) -> bytes:
    """Read all complete frames through a streaming Zstandard decoder.

    ``zstd.ZstdFile`` processes concatenated frames in C; the one-shot
    ``zstd.decompress()`` helper adds large per-frame overhead to a DSH log
    made of thousands of small frames (measured 9.9 s vs 0.14 s for an 8 MB /
    5,731-frame log).

    A live session may end in a torn frame.  The stream then yields every
    complete prefix and raises EOFError at the end; that prefix is exactly what
    the viewer should show, so stop and keep it.
    """
    chunks: list[bytes] = []
    try:
        while True:
            chunk = handle.read(ZSTD_READ_CHUNK)
            if not chunk:
                break
            chunks.append(chunk)
    except EOFError:
        pass  # torn final frame: keep the complete prefix
    except zstd.ZstdError:
        # A corrupt frame terminates the stream; keep every complete prefix
        # frame read before it instead of losing the whole session.
        pass
    return b"".join(chunks)


def _decompress_frames_legacy(data: bytes) -> bytes:
    """Salvage complete frames when the streaming decoder rejects the input.

    This is the old frame-header scanner.  It is only used when streaming
    produced no bytes at all (for example a corrupt trailing marker after all
    complete frames), so the usual fast path never pays its cost.
    """
    out: list[bytes] = []
    pos = 0
    while True:
        at = data.find(ZSTD_MAGIC, pos)
        if at < 0:
            break
        try:
            out.append(zstd.ZstdDecompressor().decompress(data[at:]))
        except Exception:
            pass
        pos = at + len(ZSTD_MAGIC)
    return b"".join(out)


def decompress_zstd(data: bytes) -> bytes:
    """Decode a concatenation of Zstandard frames from memory."""
    if zstd is None:
        raise DshError(
            "Python 3.14+ is required: the standard library module "
            "'compression.zstd' is unavailable"
        )
    if not data:
        return b""
    with zstd.ZstdFile(io.BytesIO(data), "rb") as handle:
        raw = _read_zstd_stream(handle)
    if not raw:
        raw = _decompress_frames_legacy(data)
    return raw


def read_log(path: Path) -> bytes:
    if not path.name.endswith(".zstd"):
        return path.read_bytes()
    if zstd is None:
        raise DshError(
            "Python 3.14+ is required: the standard library module "
            "'compression.zstd' is unavailable"
        )
    with zstd.ZstdFile(path, "rb") as handle:
        raw = _read_zstd_stream(handle)
    if not raw:
        raw = _decompress_frames_legacy(path.read_bytes())
    return raw


def parse_jsonl(raw: bytes) -> list[dict]:
    text = raw.decode("utf-8", "replace").lstrip("\ufeff")
    rows: list[dict] = []
    for line in text.splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            value = json.loads(line)
        except Exception:
            continue
        if isinstance(value, dict):
            rows.append(value)
    return rows


HEADER_READ_BYTES = 64 << 10  # the header is its own small Zstandard frame


def read_header(path: Path) -> dict | None:
    """Read only the session header, without decompressing the whole log.

    DSH writes the header as the first independent Zstandard frame.  Reading a
    bounded prefix and decoding just that frame is what makes listing dozens of
    large sessions fast; the full log is parsed later, on demand.
    """
    try:
        with path.open("rb") as handle:
            chunk = handle.read(HEADER_READ_BYTES)
    except OSError:
        return None
    if not chunk:
        return None
    if path.name.endswith(".zstd"):
        if zstd is None:
            return None
        try:
            first = zstd.ZstdDecompressor().decompress(chunk)
        except Exception:
            # A header frame larger than the prefix (or a torn first frame):
            # fall back to the full file, still decoding only its first frame.
            try:
                first = zstd.ZstdDecompressor().decompress(path.read_bytes())
            except Exception:
                return None
    else:
        first = chunk.split(b"\n", 1)[0] + b"\n"
    rows = parse_jsonl(first)
    for row in rows:
        if row.get("type") == "session":
            return row
    return rows[0] if rows else None


# ---------------------------------------------------------------------------
# content blocks
# ---------------------------------------------------------------------------


def blocks_of(message: dict | None) -> list[dict]:
    if not isinstance(message, dict):
        return []
    content = message.get("content")
    if isinstance(content, str):
        return [{"type": "text", "text": content}]
    if isinstance(content, list):
        return [b for b in content if isinstance(b, dict)]
    return []


def text_of(blocks: list[dict]) -> str:
    parts = []
    for block in blocks:
        if block.get("type") == "text":
            value = block.get("text")
            if isinstance(value, str) and value:
                parts.append(value)
    return "\n\n".join(parts)


def _data_uri(data: str, mime: str | None) -> str:
    mime = (mime or "image/png").strip()
    return f"data:{mime};base64,{data}"


def image_ref_from_block(block: dict) -> dict | None:
    """Normalize a DSH image content block to a small renderer-friendly dict."""
    if block.get("type") != "image":
        return None
    source = block.get("source") if isinstance(block.get("source"), dict) else {}
    mime = (
        block.get("mimeType") or block.get("mime_type") or block.get("mediaType")
        or source.get("mediaType") or source.get("media_type") or source.get("mimeType")
        or source.get("mime_type")
    )
    data = block.get("data") or source.get("data")
    if isinstance(data, str) and data and not data.startswith("data:"):
        return {"kind": "data", "src": _data_uri(data, mime), "mime": mime}
    if isinstance(data, str) and data.startswith("data:"):
        return {"kind": "data", "src": data, "mime": mime}
    for key in ("url", "href", "image_url", "imageUrl"):
        value = block.get(key) or source.get(key)
        if isinstance(value, str) and value.strip():
            return {"kind": "url", "url": value.strip()}
    for key in ("path", "file_path", "filePath", "localPath", "local_path"):
        value = block.get(key) or source.get(key)
        if isinstance(value, str) and value.strip():
            return {"kind": "path", "path": normalize_path(value)}
    att = (
        block.get("attachmentId") or block.get("attachment_id")
        or block.get("attachment") or source.get("attachmentId")
        or source.get("attachment_id") or source.get("attachment")
    )
    if isinstance(att, dict):
        att = att.get("id") or att.get("attachmentId")
    if isinstance(att, str) and att.strip():
        return {"kind": "attachment", "id": att.strip(), "mime": mime}
    if isinstance(block.get("name"), str) and is_image_path(block["name"]):
        return {"kind": "path", "path": normalize_path(block["name"])}
    return None


def text_images(text: str, *, include_markdown: bool = True) -> list[dict]:
    found: list[dict] = []
    for match in MEDIA_RE.finditer(text or ""):
        path = normalize_path(match.group(1).rstrip(".,;"))
        if is_image_path(path):
            found.append({"kind": "path", "path": path})
    for match in Q_IMAGE_RE.finditer(text or ""):
        path = normalize_path(match.group(1).rstrip(".,;"))
        if is_image_path(path):
            found.append({"kind": "path", "path": path})
    if include_markdown:
        for match in MD_IMAGE_RE.finditer(text or ""):
            raw = match.group(1).strip()
            if raw.startswith("<") and raw.endswith(">"):
                raw = raw[1:-1]
            if re.match(r"^(https?:|data:|blob:)", raw, re.I):
                continue
            path = normalize_path(raw)
            if is_image_path(path):
                found.append({"kind": "path", "path": path})
        for match in HTML_IMG_RE.finditer(text or ""):
            raw = match.group(1).strip()
            if re.match(r"^(https?:|data:|blob:)", raw, re.I):
                continue
            path = normalize_path(raw)
            if is_image_path(path):
                found.append({"kind": "path", "path": path})
    return _dedupe(found)


def image_refs_of(blocks: list[dict]) -> list[dict]:
    found = []
    for block in blocks:
        ref = image_ref_from_block(block)
        if ref:
            found.append(ref)
    return _dedupe(found)


def question_text_and_images(blocks: list[dict]) -> tuple[str, list[dict]]:
    texts: list[str] = []
    images: list[dict] = []
    # Walk the blocks in order so an inline @image marker keeps its place
    # relative to an explicit image block.
    for block in blocks:
        if block.get("type") == "text":
            value = block.get("text")
            if isinstance(value, str) and value:
                texts.append(value)
                images.extend(text_images(value))
        elif block.get("type") == "image":
            ref = image_ref_from_block(block)
            if ref:
                images.append(ref)
    text = "\n\n".join(texts)
    # The human's text is displayed as plain text, so pull image syntax out of
    # it instead of leaving raw Markdown/HTML in the question.
    cleaned = Q_IMAGE_RE.sub("", text)
    cleaned = SCREENSHOT_RE.sub("", cleaned)
    cleaned = MD_IMAGE_RE.sub("", cleaned)
    cleaned = HTML_IMG_RE.sub("", cleaned)
    cleaned = re.sub(r"[ \t]+\n", "\n", cleaned)
    cleaned = re.sub(r"\n{3,}", "\n\n", cleaned).strip()
    return cleaned, _dedupe(images)


# ---------------------------------------------------------------------------
# tool result rendering
# ---------------------------------------------------------------------------


def _parse_file_wrapper(text: str) -> dict | None:
    match = FILE_WRAPPER_RE.match(text or "")
    if not match:
        return None
    path, kind, content, tail = match.groups()
    content = content or ""
    footer = ""
    fm = FILE_FOOTER_RE.search(content)
    if fm:
        footer = fm.group(0)
        content = content[: fm.start()].rstrip()
    elif FILE_FOOTER_RE.search(tail or ""):
        footer = FILE_FOOTER_RE.search(tail).group(0)

    line_start = line_end = total = None
    fm2 = re.search(
        r"Showing lines (\d+)-(\d+) of (\d+)\.", footer or "", re.I
    )
    if fm2:
        line_start, line_end, total = (int(fm2.group(1)), int(fm2.group(2)), int(fm2.group(3)))
    else:
        fm3 = re.search(r"total (\d+) lines", footer or "", re.I)
        if fm3:
            total = int(fm3.group(1))

    # DSH's read tool prefixes every line with "N: ".  Strip it when it is
    # clearly line numbering, so the code block is copyable; keep the range.
    lines = content.splitlines()
    matches = [LINE_NO_RE.match(line) for line in lines]
    numbered = [m for m in matches if m]
    if lines and len(numbered) >= max(1, int(len(lines) * 0.8)):
        numbers = [int(m.group(1)) for m in numbered]
        if line_start is None and numbers:
            line_start, line_end = min(numbers), max(numbers)
        content = "\n".join(
            m.group(2) if m else line for m, line in zip(matches, lines)
        )
    return {
        "path": normalize_path(path.strip()),
        "kind": (kind or "").strip(),
        "content": content,
        "footer": footer,
        "line_start": line_start,
        "line_end": line_end,
        "total": total,
    }


def _wrap_part(label: str, text: str, kind: str = "text", lang: str = "plaintext") -> dict:
    return {"label": label, "kind": kind, "lang": lang, "text": text}


def render_result(
    tool_name: str,
    text: str,
    args: dict | None,
    *,
    is_error: bool = False,
    images: list[dict] | None = None,
    job: dict | None = None,
) -> dict:
    """Turn one raw tool result into structured parts + metadata for the UI."""
    args = args if isinstance(args, dict) else {}
    raw = str(text or "")
    out: dict = {
        "parts": [],
        "images": list(images or []),
        "truncated": False,
        "is_error": bool(is_error),
        "json": None,
        "path": None,
        "line_range": None,
        "exit_code": None,
        "error": None,
        "job": job or None,
    }

    # pwsh / bash: separate stderr, pull the exit-code marker out
    if tool_name in ("pwsh", "bash", "terminal", "shell"):
        clean = ANSI_RE.sub("", raw).replace("\r\n", "\n").replace("\r", "\n")
        stdout, stderr = clean, ""
        marker = "\n[stderr]\n"
        if marker in clean:
            stdout, stderr = clean.split(marker, 1)
        elif clean.startswith("[stderr]\n"):
            stdout, stderr = "", clean[len("[stderr]\n"):]
        exit_code = None
        for target in ("stdout", "stderr"):
            value = stdout if target == "stdout" else stderr
            match = EXIT_RE.search(value)
            if match:
                exit_code = int(match.group(1))
                value = EXIT_RE.sub("", value).rstrip()
                if target == "stdout":
                    stdout = value
                else:
                    stderr = value
        if exit_code is None and job and isinstance(job.get("detail"), str):
            match = re.search(r"exit code:\s*(-?\d+)", job["detail"], re.I)
            if match:
                exit_code = int(match.group(1))
        out["exit_code"] = exit_code
        if stdout.strip():
            out["parts"].append(_wrap_part("Output", stdout.rstrip(), lang="plaintext"))
        if stderr.strip():
            out["parts"].append(_wrap_part("stderr", stderr.rstrip(), lang="plaintext"))
        if exit_code not in (None, 0):
            out["is_error"] = True

    # read / write / edit: DSH wraps the result in path/type/content tags
    elif tool_name in ("read", "read_file", "read_image_file", "write", "write_file",
                       "edit", "patch", "apply_patch"):
        wrapped = _parse_file_wrapper(raw)
        if wrapped:
            out["path"] = wrapped["path"]
            if wrapped["line_start"] is not None:
                out["line_range"] = {
                    "start": wrapped["line_start"],
                    "end": wrapped["line_end"],
                    "total": wrapped["total"],
                }
            if wrapped["kind"] == "image" and is_image_path(wrapped["path"]):
                out["images"].append({"kind": "path", "path": wrapped["path"]})
            elif wrapped["content"].strip():
                label = "Content" if tool_name in ("read", "read_file", "read_image_file") else "Result"
                out["parts"].append(
                    _wrap_part(label, wrapped["content"].rstrip(), lang=lang_from_path(wrapped["path"]))
                )
        elif raw.strip():
            out["parts"].append(_wrap_part("Result", raw.rstrip(), lang="plaintext"))

    # JSON results (ask_user_question, todo_write, load_workspace_dependencies, ...)
    else:
        parsed = None
        stripped = raw.strip()
        if stripped and stripped[0] in "[{":
            try:
                parsed = json.loads(stripped)
            except Exception:
                parsed = None
        if isinstance(parsed, (dict, list)):
            out["json"] = parsed
            if isinstance(parsed, dict) and isinstance(parsed.get("error"), str) and parsed["error"].strip():
                out["error"] = parsed["error"].strip()
            if isinstance(parsed, dict) and isinstance(parsed.get("answers"), list):
                out["answers"] = parsed["answers"]
            if isinstance(parsed, dict) and isinstance(parsed.get("todos"), list):
                out["todos"] = parsed["todos"]
            # Keep a readable JSON body unless a dedicated renderer consumes it.
            if tool_name not in ("ask_user_question", "todo_write"):
                out["parts"].append(
                    _wrap_part("Result", _json_text(parsed), kind="json", lang="json")
                )
        elif raw.strip():
            out["parts"].append(_wrap_part("Result", raw.rstrip(), lang="plaintext"))

    # No placeholder part: the frontend renders a localized "no output" note
    # when there are no parts, images, or errors.

    # pull images out of text and attach them
    for part in out["parts"]:
        if part.get("kind") != "text":
            continue
        found = text_images(part["text"])
        if found:
            out["images"].extend(found)

    out["images"] = _dedupe(out["images"])[:12]

    # bound the payload
    total = 0
    for part in out["parts"]:
        text_value = str(part.get("text") or "")
        room = TOOL_RESULT_TRUNC - total
        if room <= 0:
            part["text"] = "..."
            out["truncated"] = True
            continue
        part["text"], clipped = _clip(text_value, room)
        if clipped:
            out["truncated"] = True
        total += len(part["text"])
    return out


# ---------------------------------------------------------------------------
# tool calls
# ---------------------------------------------------------------------------


def parse_args(raw: Any) -> tuple[dict, str]:
    if isinstance(raw, dict):
        return raw, _json_text(raw)
    if isinstance(raw, str):
        try:
            value = json.loads(raw)
        except Exception:
            return {}, raw
        return (value if isinstance(value, dict) else {}), raw
    return {}, "{}"


def _diff_text(path: str, old: str, new: str) -> str:
    lines = [f"--- {path}"]
    for line in str(old or "").splitlines():
        lines.append("-" + line)
    for line in str(new or "").splitlines():
        lines.append("+" + line)
    return "\n".join(lines)


def _normalize_questions(args: dict, parsed: Any) -> list[dict]:
    questions = args.get("questions")
    if not isinstance(questions, list):
        return []
    selected: dict[str, list] = {}
    custom: dict[str, str] = {}
    if isinstance(parsed, dict) and isinstance(parsed.get("answers"), list):
        for answer in parsed["answers"]:
            if isinstance(answer, dict):
                key = str(answer.get("id"))
                value = answer.get("selected")
                selected[key] = value if isinstance(value, list) else ([value] if value else [])
                if isinstance(answer.get("custom"), str) and answer["custom"].strip():
                    custom[key] = answer["custom"].strip()
    out = []
    for question in questions:
        if not isinstance(question, dict):
            continue
        options = []
        for option in question.get("options") or []:
            if isinstance(option, dict):
                options.append({
                    "label": str(option.get("label") or ""),
                    "description": str(option.get("description") or ""),
                })
        key = str(question.get("id"))
        out.append({
            "id": question.get("id"),
            "header": question.get("header"),
            "question": question.get("question"),
            "options": options,
            "multi_select": bool(question.get("multi_select")),
            "selected": selected.get(key, []),
            "custom": custom.get(key, ""),
        })
    return out


def _normalize_todos(value: Any) -> list[dict]:
    if isinstance(value, dict):
        value = value.get("todos") or value.get("items") or value.get("list")
    if not isinstance(value, list):
        return []
    out = []
    for item in value:
        if isinstance(item, dict):
            content = item.get("content") or item.get("text") or item.get("title") or item.get("task")
            if content is None:
                continue
            out.append({
                "content": str(content),
                "status": str(item.get("status") or item.get("state") or ""),
            })
        elif isinstance(item, str):
            out.append({"content": item, "status": ""})
    return out


def _summary_for(name: str, args: dict) -> str:
    if name == "pwsh":
        description = args.get("description")
        if isinstance(description, str) and description.strip():
            return description.strip().splitlines()[0][:160]
        command = args.get("command")
        if isinstance(command, str):
            return command.strip().splitlines()[0][:160] if command.strip() else ""
    if name == "ask_user_question":
        return ""          # frontend localizes the count
    if name == "todo_write":
        return ""          # frontend localizes the count
    if name == "present":
        return ""          # frontend localizes the count
    if name in ("subagent", "subagent_fork"):
        description = args.get("description")
        if isinstance(description, str) and description.strip():
            return description.strip()[:160]
        return ""
    if name == "workflow":
        meta = args.get("meta")
        if isinstance(meta, dict) and meta.get("name"):
            return str(meta["name"])[:160]
    if name == "web_search":
        queries = args.get("queries")
        if isinstance(queries, list) and queries:
            return ", ".join(str(q) for q in queries[:3])[:160]
    for key in SUMMARY_KEYS:
        value = args.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip().splitlines()[0][:160]
        if isinstance(value, (list, tuple)) and value and isinstance(value[0], str):
            return ", ".join(str(v) for v in value[:3])[:160]
    return ""


def _info_for(name: str, args: dict) -> list[str]:
    info = []
    if name in ("read", "read_file", "read_image_file"):
        path = args.get("file_path") or args.get("path")
        if path:
            info.append(normalize_path(path))
    elif name in ("glob", "grep"):
        pattern = args.get("pattern")
        if pattern:
            info.append(str(pattern))
        path = args.get("path")
        if path:
            info.append(normalize_path(path))
    elif name == "web_fetch":
        url = args.get("url")
        if url:
            info.append(str(url))
    elif name in ("subagent", "subagent_fork"):
        for key in ("description", "prompt"):
            if args.get(key):
                info.append(str(args[key]).splitlines()[0][:200])
                break
    return info


def _arg_view(name: str, args: dict, raw: str) -> dict | None:
    if name in CODE_ARG:
        key, lang = CODE_ARG[name]
        value = args.get(key)
        if isinstance(value, str) and value:
            text, truncated = _clip(value, ARG_TRUNC)
            return {
                "kind": "code", "label": "Command", "lang": lang, "text": text,
                "truncated": truncated,
            }
    if name == "write":
        path = normalize_path(args.get("file_path") or args.get("path") or "")
        content = args.get("content")
        if isinstance(content, str):
            text, truncated = _clip(content, ARG_TRUNC)
            return {
                "kind": "code", "label": path or "Content",
                "lang": lang_from_path(path), "text": text, "truncated": truncated,
            }
    if name in ("edit", "patch", "apply_patch"):
        path = normalize_path(args.get("file_path") or args.get("path") or "")
        old = args.get("old_string")
        new = args.get("new_string")
        if isinstance(old, str) or isinstance(new, str):
            return {
                "kind": "diff", "label": path or "Diff",
                "lang": "diff", "text": _diff_text(path, old or "", new or ""),
            }
    if name in ("subagent", "subagent_fork"):
        for key in ("prompt", "description"):
            value = args.get(key)
            if isinstance(value, str) and value:
                text, truncated = _clip(value, ARG_TRUNC)
                return {
                    "kind": "code", "label": "Prompt", "lang": "markdown",
                    "text": text, "truncated": truncated,
                }
    if name == "workflow":
        script = args.get("script")
        if isinstance(script, str) and script:
            text, truncated = _clip(script, ARG_TRUNC)
            return {
                "kind": "code", "label": "Workflow script", "lang": "javascript",
                "text": text, "truncated": truncated,
            }
    if name in ("ask_user_question", "todo_write", "present", "web_search", "web_fetch",
                "read", "read_file", "read_image_file", "skill"):
        return None
    if args:
        raw_text = raw if isinstance(raw, str) and raw.strip() else _json_text(args)
        text, truncated = _clip(raw_text, ARG_TRUNC)
        return {
            "kind": "json", "label": "Arguments", "lang": "json",
            "text": text, "truncated": truncated,
        }
    return None


def call_payload(call: dict) -> dict:
    name = str(call.get("name") or "tool")
    args = call.get("args") if isinstance(call.get("args"), dict) else {}
    raw = str(call.get("args_raw") or "")

    result = None
    if call.get("result_text") is not None:
        result = render_result(
            name,
            call.get("result_text") or "",
            args,
            is_error=bool(call.get("is_error")),
            images=call.get("result_images") or [],
            job=call.get("job"),
        )
        if call.get("error") and not result.get("error"):
            result["error"] = str(call["error"])
            result["is_error"] = True
    elif call.get("error"):
        result = render_result(name, "", args, is_error=True)
        result["error"] = str(call["error"])

    payload: dict = {
        "id": call.get("id") or "",
        "name": name,
        "args_raw": _clip(raw, ARG_TRUNC)[0],
        "summary": _summary_for(name, args),
        "info": _info_for(name, args),
        "arg_view": _arg_view(name, args, raw),
        "result": result,
        "job": call.get("job"),
        "step": call.get("step"),
    }

    parsed = (result or {}).get("json")
    if name == "ask_user_question":
        payload["questions"] = _normalize_questions(args, parsed)
    if name == "todo_write":
        payload["todos"] = _normalize_todos(
            (parsed or {}).get("todos") if isinstance(parsed, dict) else None
        ) or _normalize_todos(args.get("todos"))
    if name == "present":
        files = args.get("files")
        payload["files"] = files if isinstance(files, list) else []
    if name == "web_search":
        payload["queries"] = args.get("queries") if isinstance(args.get("queries"), list) else []
    if name == "web_fetch":
        payload["url"] = args.get("url")
    if name == "skill":
        payload["skill"] = args.get("name")
    return payload


def calls_payload(turn: dict) -> list[dict]:
    """Render every tool call of one turn for the API.

    Kept out of ``build_session``: rendering command output, diffs and file
    contents for every turn is expensive and only the opened turn needs it.
    """
    return [call_payload(call) for call in (turn.get("calls") or [])]


def calls_revision(turn: dict) -> str:
    """Cheap signature of a turn's call ids and result sizes.

    The UI uses it to decide whether its cached, already-expanded tool cards
    are still current while a live answer keeps growing.
    """
    digest = hashlib.blake2b(digest_size=8)
    for call in turn.get("calls") or []:
        digest.update(str(call.get("id") or "").encode("utf-8", "replace"))
        digest.update(b"\0")
        result = call.get("result_text")
        digest.update(b"1" if result is not None else b"0")
        digest.update(str(len(result or "")).encode("ascii"))
        digest.update(b"\0")
        digest.update(b"1" if call.get("is_error") else b"0")
        digest.update(b"\0")
    return digest.hexdigest()


# ---------------------------------------------------------------------------
# session parsing
# ---------------------------------------------------------------------------


def _new_turn(
    sid: str,
    seq: int,
    ts: int,
    question: str,
    images: list[dict],
    steer: bool,
    turn_no: Any,
    *,
    synthetic: bool = False,
    synthetic_kind: str = "",
) -> dict:
    return {
        "q_id": f"{sid}:{seq}",
        "seq": seq,
        "q": question,
        "q_images": images,
        "steer": bool(steer),
        "synthetic": bool(synthetic),
        "synthetic_kind": synthetic_kind,
        "ts": ts,
        "turn": turn_no,
        "answer_parts": [],
        "reasoning": [],
        "calls": [],
        "compactions": [],
        "todos": [],
        "notices": [],
        "answer_images": [],
        "end_reason": None,
    }


def _add_call(turn: dict, call_id: Any, name: Any, args_raw: Any, step: Any = None) -> dict:
    cid = str(call_id or "")
    if not cid:
        cid = f"anon-{len(turn['calls']) + 1}"
    for call in turn["calls"]:
        if call["id"] == cid:
            if name and (not call.get("name") or call.get("name") == "tool"):
                call["name"] = str(name)
            if args_raw not in (None, "", "{}") and not call.get("args_raw"):
                args, raw = parse_args(args_raw)
                call["args"] = args
                call["args_raw"] = raw
            if step is not None and call.get("step") is None:
                call["step"] = step
            return call
    args, raw = parse_args(args_raw)
    call = {
        "id": cid,
        "name": str(name or "tool"),
        "args": args,
        "args_raw": raw,
        "step": step,
        "result_text": None,
        "result_images": [],
        "is_error": False,
        "error": None,
        "job": None,
    }
    turn["calls"].append(call)
    return call


def _find_call(turn: dict, call_id: str) -> dict | None:
    for call in turn["calls"]:
        if call["id"] == call_id:
            return call
    return None


def _compaction_text(data: dict) -> str:
    for key in ("summary", "text", "content", "rawOutput", "raw_output"):
        value = data.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()
        if isinstance(value, list):
            text = text_of(value)
            if text.strip():
                return text.strip()
    message = data.get("message")
    if isinstance(message, dict):
        text = text_of(blocks_of(message))
        if text.strip():
            return text.strip()
    return ""


def _notice_for(event_type: str, data: dict) -> dict | None:
    if event_type == "plan/mode":
        active = data.get("active", data.get("enabled"))
        if active is None:
            return None
        return {"key": "plan_mode", "active": bool(active)}
    if event_type == "model/selection":
        provider = data.get("provider")
        model = data.get("model")
        if provider or model:
            return {"key": "model_switch", "provider": provider, "model": model}
    if event_type == "working-directory/change":
        cwd = data.get("cwd") or data.get("path")
        if cwd:
            return {"key": "working_directory", "cwd": cwd}
    if event_type == "goal/change":
        action = data.get("action") or data.get("kind")
        goal = data.get("goal")
        if isinstance(goal, dict):
            goal = goal.get("objective") or goal.get("text")
        return {"key": "goal", "action": action, "goal": goal}
    if event_type == "approval/decided":
        decision = data.get("decision") or data.get("approved")
        if decision is not None:
            return {"key": "approval", "decision": decision}
    return None


def build_session(sid: str, header: dict, events: list[dict], proj: dict | None = None) -> dict:
    proj = proj or {}
    turns: list[dict] = []
    cur: dict | None = None
    open_turn_no: Any = None
    turn_open = False
    saw_assistant = False
    pending_user = False
    title = ""
    model = ""
    provider = ""
    last_activity = int(header.get("createdAt") or 0)
    message_count = 0
    pending_compactions: list[dict] = []
    pending_todos: list[dict] = []

    for event in events:
        if not isinstance(event, dict):
            continue
        etype = str(event.get("type") or "")
        data = event.get("data") if isinstance(event.get("data"), dict) else {}
        seq = event.get("seq")
        seq = int(seq) if isinstance(seq, (int, float)) else 0
        ts = event.get("time")
        ts = int(ts) if isinstance(ts, (int, float)) else 0
        last_activity = max(last_activity, ts)

        if etype == "session/title":
            value = data.get("title")
            if isinstance(value, str) and value.strip():
                title = value.strip()

        elif etype == "request/context":
            model = str(data.get("model") or model)
            provider = str(data.get("provider") or provider)

        elif etype == "request/header":
            header_obj = data.get("header") if isinstance(data.get("header"), dict) else {}
            config = header_obj.get("config") if isinstance(header_obj.get("config"), dict) else {}
            model = str(config.get("model") or model)
            provider = str(config.get("provider") or provider)

        elif etype == "turn/start":
            open_turn_no = data.get("turn")
            turn_open = True
            saw_assistant = False
            pending_user = True

        elif etype == "turn/end":
            turn_open = False
            pending_user = False
            reason = data.get("reason")
            if cur is not None and reason is not None:
                cur["end_reason"] = reason

        elif etype == "user/message":
            message_count += 1
            message = data.get("message") if isinstance(data.get("message"), dict) else {}
            source = data.get("source") if isinstance(data.get("source"), dict) else (
                message.get("source") if isinstance(message.get("source"), dict) else {}
            )
            kind = str(source.get("kind") or "")
            if kind and kind != "user":
                # runtime-context / skill-catalog / time-context / user-approval
                # are injected context: never questions, never turn boundaries.
                continue
            content = data.get("content")
            if not isinstance(content, list):
                content = message.get("content") if isinstance(message.get("content"), list) else []
            question, images = question_text_and_images(content)
            steer = bool(cur is not None and saw_assistant)
            cur = _new_turn(
                sid, seq, ts, question, images, steer, open_turn_no
            )
            cur["compactions"].extend(pending_compactions)
            pending_compactions.clear()
            if pending_todos:
                cur["todos"] = pending_todos[-1]["todos"]
                pending_todos.clear()
            turns.append(cur)
            saw_assistant = False
            pending_user = False

        elif etype == "assistant/message":
            message_count += 1
            # A new turn can start without a human message (goal/automatic
            # continuation).  Give its output its own card instead of silently
            # appending it to the previous answer.
            new_turn_without_user = bool(
                cur is None
                or (pending_user and open_turn_no is not None and cur.get("turn") != open_turn_no)
            )
            if new_turn_without_user:
                kind = "auto" if turns else "orphan"
                cur = _new_turn(
                    sid, seq, ts, "", [], False,
                    open_turn_no if open_turn_no is not None else data.get("turn"),
                    synthetic=True, synthetic_kind=kind,
                )
                cur["compactions"].extend(pending_compactions)
                pending_compactions.clear()
                if pending_todos:
                    cur["todos"] = pending_todos[-1]["todos"]
                    pending_todos.clear()
                turns.append(cur)
                pending_user = False
            saw_assistant = True
            message = data.get("message") if isinstance(data.get("message"), dict) else {
                "content": data.get("content")
            }
            step = data.get("step")
            for block in blocks_of(message):
                btype = block.get("type")
                if btype == "text":
                    value = block.get("text")
                    if isinstance(value, str) and value:
                        cur["answer_parts"].append(value)
                elif btype in ("reasoning", "thinking"):
                    value = block.get("text")
                    if isinstance(value, str) and value.strip():
                        cur["reasoning"].append({"step": step, "text": value})
                elif btype in ("tool-call", "tool_call"):
                    call_id = block.get("id") or block.get("callId") or block.get("call_id")
                    name = block.get("name")
                    arguments = block.get("arguments")
                    if arguments is None:
                        arguments = block.get("input")
                    _add_call(cur, call_id, name, arguments, step)
                elif btype == "image":
                    ref = image_ref_from_block(block)
                    if ref:
                        cur["answer_images"].append(ref)

        elif etype == "tool/call":
            if cur is None:
                cur = _new_turn(
                    sid, seq, ts, "", [], False,
                    data.get("turn"), synthetic=True, synthetic_kind="orphan",
                )
                cur["compactions"].extend(pending_compactions)
                pending_compactions.clear()
                turns.append(cur)
                saw_assistant = True
            _add_call(cur, data.get("callId") or data.get("call_id"), data.get("name"), data.get("arguments"), data.get("step"))

        elif etype == "tool/result":
            message_count += 1
            if cur is None:
                cur = _new_turn(
                    sid, seq, ts, "", [], False,
                    data.get("turn"), synthetic=True, synthetic_kind="orphan",
                )
                cur["compactions"].extend(pending_compactions)
                pending_compactions.clear()
                turns.append(cur)
            message = data.get("message") if isinstance(data.get("message"), dict) else {}
            call_id = str(message.get("toolCallId") or data.get("toolCallId") or data.get("tool_call_id") or "")
            call = _find_call(cur, call_id) if call_id else None
            if call is None:
                call = _add_call(cur, call_id or f"anon-{seq}", "tool", "{}", data.get("step"))
            content_blocks = blocks_of(message)
            if not content_blocks and isinstance(data.get("content"), list):
                content_blocks = [b for b in data["content"] if isinstance(b, dict)]
            call["result_text"] = text_of(content_blocks)
            call["result_images"] = image_refs_of(content_blocks)
            call["is_error"] = bool(
                message.get("isError") or data.get("isError") or data.get("error")
            )
            if data.get("error") is not None:
                err = data["error"]
                call["error"] = err if isinstance(err, str) else _json_text(err)
            if not call["name"] or call["name"] == "tool":
                # A result row does not carry the tool name; a preceding
                # assistant tool-call block often does, and tool/call events
                # usually arrive first.  Leave "tool" as the last resort.
                pass

        elif etype == "job/settled":
            tool_call = data.get("toolCall") if isinstance(data.get("toolCall"), dict) else {}
            call_id = str(tool_call.get("callId") or "")
            call = _find_call(cur, call_id) if (cur and call_id) else None
            if call is not None:
                started = data.get("startedAt")
                finished = data.get("finishedAt")
                duration = None
                if isinstance(started, (int, float)) and isinstance(finished, (int, float)):
                    duration = max(0, int(finished - started))
                call["job"] = {
                    "status": data.get("status"),
                    "detail": data.get("detail"),
                    "duration_ms": duration,
                }

        elif etype in ("compaction/summary", "compaction/start", "compaction/end"):
            if etype == "compaction/summary":
                text = _compaction_text(data)
                if text:
                    item = {
                        "seq": seq,
                        "ts": ts,
                        "text": text,
                        "summary": preview(text, 300),
                    }
                    if cur is not None:
                        cur["compactions"].append(item)
                    else:
                        pending_compactions.append(item)

        elif etype == "todo/write":
            todos = _normalize_todos(data.get("todos") or data.get("items") or data)
            if todos:
                if cur is not None:
                    cur["todos"] = todos
                else:
                    pending_todos.append({"seq": seq, "todos": todos})

        else:
            notice = _notice_for(etype, data)
            if notice and cur is not None:
                cur["notices"].append({"seq": seq, "kind": etype, **notice})

    # Finalize turns -------------------------------------------------------
    real_turns = [t for t in turns if not t.get("synthetic")]
    last = turns[-1] if turns else None
    for turn in turns:
        answer = "\n\n".join(part for part in turn["answer_parts"] if part and part.strip())
        turn["answer"] = answer.strip()
        turn["answer_chars"] = len(turn["answer"])
        turn["reasoning_chars"] = sum(len(r.get("text") or "") for r in turn["reasoning"])
        names: dict[str, int] = {}
        for call in turn["calls"]:
            names[call["name"]] = names.get(call["name"], 0) + 1
        turn["tool_summary"] = [{"name": n, "count": c} for n, c in sorted(names.items())]
        turn["open"] = bool(
            turn is last
            and turn_open
            and (open_turn_no is None or turn.get("turn") in (None, open_turn_no))
        )
        turn["preview"] = preview(turn["q"], 80)
        turn["answer_preview"] = preview(turn["answer"], 110)
        turn.pop("answer_parts", None)

    if not title:
        first_q = next((t["q"] for t in real_turns if t["q"].strip()), "")
        title = proj.get("title") or preview(first_q, 60) or ""
    if not model:
        model = str(proj.get("model") or "")
    if not provider:
        provider = str(proj.get("provider") or "")

    return {
        "id": sid,
        "path": "",
        "header": header,
        "title": title,
        "cwd": str(header.get("cwd") or proj.get("cwd") or ""),
        "created_at": int(header.get("createdAt") or (events[0].get("time") if events else 0) or 0),
        "last_activity_at": last_activity,
        "model": model,
        "provider": provider,
        "turns": turns,
        "real_turn_count": len(real_turns),
        "message_count": message_count,
        "parent": header.get("parentSession"),
        "origin": header.get("origin"),
        "depth": header.get("delegationDepth"),
        "tokens": proj.get("tokens") or {},
        "stats": proj.get("stats") or {},
        "agent_preset": header.get("agentPreset"),
        "is_seeded": bool(header.get("isSeeded")),
    }


def parse_session_file(path: Path, proj: dict | None = None) -> dict | None:
    raw = read_log(path)
    rows = parse_jsonl(raw)
    header = None
    events: list[dict] = []
    for row in rows:
        if row.get("type") == "session" and header is None:
            header = row
        elif row.get("type"):
            events.append(row)
    if header is None:
        return None
    sid = str(header.get("id") or path.parent.name)
    events.sort(key=lambda e: (int(e.get("seq") or 0)))
    session = build_session(sid, header, events, proj)
    session["path"] = str(path)
    return session


# ---------------------------------------------------------------------------
# DSH home / metadata
# ---------------------------------------------------------------------------


def dsh_home(explicit: str | None = None) -> Path:
    if explicit:
        return Path(explicit).expanduser().resolve()
    env = os.environ.get("DSH_HOME")
    if env:
        return Path(env).expanduser().resolve()
    return (Path.home() / ".dsh").resolve()


def discover_session_files(sessions_root: Path) -> list[Path]:
    """Return the highest canonical generation for every session directory."""
    groups: dict[Path, list[tuple[int, int, Path]]] = {}
    if not sessions_root.is_dir():
        return []
    for path in sessions_root.rglob("session*.jsonl*"):
        match = SESSION_FILE_RE.match(path.name)
        if not match or not path.is_file():
            continue
        version = int(match.group(1) or 0)
        compressed = 1 if match.group(2) else 0
        groups.setdefault(path.parent, []).append((version, compressed, path))
    chosen = []
    for candidates in groups.values():
        candidates.sort(key=lambda item: (item[0], item[1]), reverse=True)
        chosen.append(candidates[0][2])
    return sorted(chosen)


def _row_value(rows: dict, key: str) -> Any:
    value = rows.get(key)
    if isinstance(value, dict) and "val" in value:
        return value.get("val")
    return None


def load_projcache(home: Path, sid: str) -> dict:
    path = home / "storages" / "session_projcache" / "sessions" / f"{sid}.json"
    try:
        obj = json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return {}
    rows = ((obj.get("record") or {}).get("rows") if isinstance(obj, dict) else None) or {}
    if not isinstance(rows, dict):
        return {}
    tokens = _row_value(rows, "tokenUsage")
    stats = _row_value(rows, "sessionStats")
    model_sel = _row_value(rows, "modelSelection")
    title = _row_value(rows, "title")
    working = _row_value(rows, "workingDirectory")
    title_input = _row_value(rows, "titleInput")
    time_context = _row_value(rows, "timeContext")
    session_list = _row_value(rows, "sessionListMetadata")
    outline = _row_value(rows, "turnOutline")
    stats = stats if isinstance(stats, dict) else {}
    out = {
        "title": title if isinstance(title, str) else "",
        "tokens": (tokens or {}).get("totals") if isinstance(tokens, dict) else {},
        "stats": stats,
        "cwd": working if isinstance(working, str) else "",
        "title_input_count": 0,
        "outline_count": 0,
        "last_message_time": 0,
        "last_prompt_at": 0,
        "open": bool(stats.get("openStep")),
    }
    if isinstance(title_input, dict):
        try:
            out["title_input_count"] = max(0, int(title_input.get("count") or 0))
        except (TypeError, ValueError):
            pass
    if isinstance(outline, dict) and isinstance(outline.get("turns"), list):
        out["outline_count"] = len(outline["turns"])
    if isinstance(time_context, dict):
        try:
            out["last_message_time"] = max(0, int(time_context.get("lastMessageTime") or 0))
        except (TypeError, ValueError):
            pass
    if isinstance(session_list, dict):
        try:
            out["last_prompt_at"] = max(0, int(session_list.get("lastPromptAt") or 0))
        except (TypeError, ValueError):
            pass
    if isinstance(model_sel, dict):
        last = model_sel.get("lastUsed") if isinstance(model_sel.get("lastUsed"), dict) else {}
        out["model"] = last.get("model") or ""
        out["provider"] = last.get("provider") or ""
    return out


def metadata_question_count(proj: dict) -> int:
    """Best question count available without reading the event log.

    ``sessionStats.turns`` counts agent turns; a mid-turn steer adds a user
    message without a new turn, and ``titleInput.count`` counts those human
    messages.  Their maximum matched full parsing on every local session.
    """
    values = [proj.get("outline_count"), proj.get("title_input_count")]
    stats = proj.get("stats") if isinstance(proj.get("stats"), dict) else {}
    values.append(stats.get("turns"))
    best = 0
    for value in values:
        try:
            best = max(best, int(value or 0))
        except (TypeError, ValueError):
            pass
    return best


def load_workspace_meta(home: Path) -> tuple[dict[str, dict], set[str], set[str]]:
    """Return (session -> workspace, pinned ids, archived ids)."""
    path = home / "storages" / "workspace.json"
    try:
        obj = json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return {}, set(), set()
    global_cfg = obj.get("global") if isinstance(obj, dict) else {}
    global_cfg = global_cfg if isinstance(global_cfg, dict) else {}
    pinned = set(global_cfg.get("pinnedSessionIds") or [])
    archived = set(global_cfg.get("archivedSessionIds") or [])
    tables = obj.get("tables") if isinstance(obj, dict) else {}
    workspaces = (tables or {}).get("workspaces") if isinstance(tables, dict) else {}
    mapping: dict[str, dict] = {}
    if isinstance(workspaces, dict):
        for wid, workspace in workspaces.items():
            if not isinstance(workspace, dict):
                continue
            ws = {
                "id": wid,
                "path": workspace.get("path") or "",
                "title": workspace.get("title") or Path(str(workspace.get("path") or "")).name,
            }
            for sid in workspace.get("sessionIds") or []:
                mapping[str(sid)] = ws
    return mapping, pinned, archived


# ---------------------------------------------------------------------------
# store
# ---------------------------------------------------------------------------


@dataclass
class _CacheEntry:
    stamp: tuple[int, int] | None
    data: dict | None


@dataclass
class _LoadedSession:
    """A fully parsed log, kept only after the user opens that session."""

    stamp: tuple[int, int] | None
    data: dict


class Store:
    """Metadata-first session store; full logs are parsed on demand.

    Listing sessions reads only the first Zstandard frame (the session header)
    plus the small projection cache, so startup stays fast even when the
    history contains hundreds of megabytes of logs.
    """

    def __init__(self, home: Path):
        self.home = home
        self.sessions_root = home / "sessions"
        self._lock = threading.RLock()
        self._load_lock = threading.Lock()
        self._stamp: tuple | None = None
        self._chats: list[dict] = []
        self._by_id: dict[str, dict] = {}
        self._cache: dict[str, _CacheEntry] = {}
        self._sessions: dict[str, _LoadedSession] = {}

    # -- change detection --------------------------------------------------
    def _files(self) -> list[Path]:
        files = discover_session_files(self.sessions_root)
        meta = self.home / "storages" / "workspace.json"
        if meta.is_file():
            files.append(meta)
        cache_dir = self.home / "storages" / "session_projcache" / "sessions"
        if cache_dir.is_dir():
            files.extend(sorted(cache_dir.glob("*.json")))
        return files

    def _current_stamp(self, files: list[Path]) -> tuple:
        parts = []
        for path in files:
            try:
                stat = path.stat()
                parts.append((str(path), stat.st_mtime_ns, stat.st_size))
            except OSError:
                parts.append((str(path), None, None))
        return tuple(parts)

    def ensure(self) -> None:
        files = self._files()
        stamp = self._current_stamp(files)
        if stamp == self._stamp:
            return
        with self._lock:
            if stamp != self._stamp:
                self._rebuild(files)

    # -- rebuild -----------------------------------------------------------
    def _proj(self, sid: str) -> dict:
        cache_key = f"proj:{sid}"
        path = self.home / "storages" / "session_projcache" / "sessions" / f"{sid}.json"
        try:
            st = path.stat()
            stamp = (st.st_mtime_ns, st.st_size)
        except OSError:
            stamp = None
        entry = self._cache.get(cache_key)
        if entry and entry.stamp == stamp:
            return entry.data or {}
        data = load_projcache(self.home, sid)
        self._cache[cache_key] = _CacheEntry(stamp, data)
        return data

    def _file_stamp(self, path: Path) -> tuple[int, int] | None:
        try:
            stat = path.stat()
            return (stat.st_mtime_ns, stat.st_size)
        except OSError:
            return None

    @staticmethod
    def _cwd_key(path: str | None) -> str:
        return str(path or "").replace("\\", "/").rstrip("/").casefold()

    @classmethod
    def _workspace_for(
        cls,
        sid: str,
        cwd: str,
        workspace_map: dict[str, dict],
        workspace_by_path: dict[str, dict] | None = None,
    ) -> dict:
        if sid in workspace_map:
            return workspace_map[sid]
        if workspace_by_path and cwd:
            workspace = workspace_by_path.get(cls._cwd_key(cwd))
            if workspace:
                return workspace
        return {
            "id": "",
            "path": cwd,
            "title": Path(cwd).name if cwd else "",
        }

    def _build_meta(
        self,
        sid: str,
        header: dict,
        proj: dict,
        path: Path,
        stamp: tuple[int, int] | None,
        workspace_map: dict[str, dict],
        workspace_by_path: dict[str, dict],
        pinned: set[str],
        archived: set[str],
    ) -> dict:
        created = int(header.get("createdAt") or 0)
        cwd = str(header.get("cwd") or proj.get("cwd") or "")
        mtime_ms = int(stamp[0] // 1_000_000) if stamp else 0
        last_activity = max(
            created,
            mtime_ms,
            int(proj.get("last_message_time") or 0),
            int(proj.get("last_prompt_at") or 0),
        )
        title = str(proj.get("title") or "").strip()
        if not title:
            title = Path(cwd).name if cwd else ""
        return {
            "id": sid,
            "title": title,
            "cwd": cwd,
            "created_at": created,
            "last_activity_at": last_activity,
            "model": str(proj.get("model") or ""),
            "provider": str(proj.get("provider") or ""),
            "questions": metadata_question_count(proj),
            "answered": 0,
            "message_count": 0,
            "open": bool(proj.get("open")),
            "pinned": sid in pinned,
            "archived": sid in archived,
            "parent": header.get("parentSession"),
            "origin": header.get("origin"),
            "depth": header.get("delegationDepth"),
            "agent_preset": header.get("agentPreset"),
            "is_seeded": bool(header.get("isSeeded")),
            "tokens": proj.get("tokens") or {},
            "stats": proj.get("stats") or {},
            "workspace": self._workspace_for(sid, cwd, workspace_map, workspace_by_path),
            "path": str(path),
            "error": None,
            "loaded": False,
            "_file_stamp": stamp,
        }

    def _error_meta(
        self,
        sid: str,
        proj: dict,
        path: Path,
        stamp: tuple[int, int] | None,
        workspace_map: dict[str, dict],
        workspace_by_path: dict[str, dict],
        pinned: set[str],
        archived: set[str],
        message: str,
    ) -> dict:
        cwd = str(proj.get("cwd") or "")
        mtime_ms = int(stamp[0] // 1_000_000) if stamp else 0
        return {
            "id": sid,
            "title": path.name,
            "cwd": cwd,
            "created_at": 0,
            "last_activity_at": mtime_ms,
            "model": str(proj.get("model") or ""),
            "provider": str(proj.get("provider") or ""),
            "questions": metadata_question_count(proj),
            "answered": 0,
            "message_count": 0,
            "open": False,
            "pinned": sid in pinned,
            "archived": sid in archived,
            "parent": None,
            "origin": None,
            "depth": None,
            "agent_preset": None,
            "is_seeded": False,
            "tokens": proj.get("tokens") or {},
            "stats": proj.get("stats") or {},
            "workspace": self._workspace_for(sid, cwd, workspace_map, workspace_by_path),
            "path": str(path),
            "error": message,
            "loaded": False,
            "_file_stamp": stamp,
        }

    @staticmethod
    def _apply_loaded_meta(meta: dict, session: dict) -> None:
        turns = session.get("turns") or []
        meta["questions"] = len(turns)
        meta["answered"] = sum(
            1 for turn in turns
            if (turn.get("answer") or "").strip() or turn.get("calls")
        )
        meta["message_count"] = int(session.get("message_count") or 0)
        meta["open"] = bool(turns and turns[-1].get("open"))
        meta["last_activity_at"] = max(
            int(meta.get("last_activity_at") or 0),
            int(session.get("last_activity_at") or 0),
        )
        title = str(session.get("title") or "").strip()
        if title:
            meta["title"] = title
        for key in (
            "model", "provider", "cwd", "tokens", "stats", "origin",
            "parent", "depth", "agent_preset", "is_seeded",
        ):
            value = session.get(key)
            if value not in (None, "", {}, []):
                meta[key] = value
        meta["loaded"] = True
        meta["error"] = None

    def _rebuild(self, files: list[Path]) -> None:
        workspace_map, pinned, archived = load_workspace_meta(self.home)
        workspace_by_path: dict[str, dict] = {}
        for workspace in workspace_map.values():
            path = str(workspace.get("path") or "")
            if path:
                workspace_by_path.setdefault(self._cwd_key(path), workspace)
        chats: list[dict] = []
        by_id: dict[str, dict] = {}

        for path in files:
            if not SESSION_FILE_RE.match(path.name):
                continue
            stamp = self._file_stamp(path)
            header = read_header(path)
            if header is None:
                sid = path.parent.name
                proj = self._proj(sid)
                meta = self._error_meta(
                    sid, proj, path, stamp, workspace_map, workspace_by_path,
                    pinned, archived,
                    "Could not read the session header (the file may be mid-write or corrupt)",
                )
            else:
                sid = str(header.get("id") or path.parent.name)
                proj = self._proj(sid)
                meta = self._build_meta(
                    sid, header, proj, path, stamp, workspace_map,
                    workspace_by_path, pinned, archived,
                )

            loaded = self._sessions.get(sid)
            if loaded is not None and stamp is not None and loaded.stamp == stamp:
                # Keep the exact counts once a session has been opened, even if
                # a later metadata refresh produced a lower estimate.
                self._apply_loaded_meta(meta, loaded.data)
            elif loaded is not None:
                self._sessions.pop(sid, None)

            by_id[sid] = meta
            chats.append(meta)

        chats.sort(
            key=lambda c: (
                0 if c.get("pinned") else 1,
                -(c.get("last_activity_at") or 0),
            )
        )
        self._chats = chats
        self._by_id = by_id
        self._stamp = self._current_stamp(self._files())
        for sid in list(self._sessions):
            if sid not in by_id:
                self._sessions.pop(sid, None)
        for key in list(self._cache):
            if key.startswith("proj:") and key[5:] not in by_id:
                self._cache.pop(key, None)

    def _ensure_loaded(self, sid: str) -> dict | None:
        """Parse one session log, once, the first time its content is needed."""
        self.ensure()
        meta = self._by_id.get(sid)
        if meta is None:
            return None
        path = Path(str(meta.get("path") or ""))
        stamp = self._file_stamp(path)
        with self._load_lock:
            cached = self._sessions.get(sid)
            if cached is not None and stamp is not None and cached.stamp == stamp:
                return cached.data
            proj = self._proj(sid)
            try:
                session = parse_session_file(path, proj)
            except Exception as exc:
                meta["error"] = f"{type(exc).__name__}: {exc}"
                self._sessions.pop(sid, None)
                return None
            if session is None:
                meta["error"] = "Could not parse the session header"
                self._sessions.pop(sid, None)
                return None
            self._sessions[sid] = _LoadedSession(stamp, session)
            current = self._by_id.get(sid) or meta
            self._apply_loaded_meta(current, session)
            return session

    # -- public ------------------------------------------------------------
    def chats(self) -> list[dict]:
        self.ensure()
        return self._chats

    def chat(self, sid: str) -> dict | None:
        self.ensure()
        return self._by_id.get(sid)

    def turns(self, sid: str) -> list[dict]:
        session = self._ensure_loaded(sid)
        return session.get("turns") if session else []

    def turn(self, sid: str, seq: int) -> dict | None:
        for turn in self.turns(sid):
            if int(turn.get("seq") or -1) == int(seq):
                return turn
        return None

    def meta(self) -> dict:
        chats = self.chats()
        return {
            "home": str(self.home),
            "sessions_root": str(self.sessions_root),
            "sessions": len(chats),
            "questions": sum(c.get("questions") or 0 for c in chats),
            "workspaces": len({
                (c.get("workspace") or {}).get("id") or (c.get("workspace") or {}).get("path")
                for c in chats
            }),
            "loaded": sum(1 for c in chats if c.get("loaded")),
        }

    def search(self, term: str, sid: str | None, scope: str, limit: int) -> list[dict]:
        needle = term.casefold()
        out: list[dict] = []
        for chat in self.chats():
            if sid and chat["id"] != sid:
                continue
            for turn in self.turns(chat["id"]):
                in_q = needle in (turn.get("q") or "").casefold()
                in_a = needle in (turn.get("answer") or "").casefold()
                if scope == "q" and not in_q:
                    continue
                if scope == "a" and not in_a:
                    continue
                if scope == "all" and not (in_q or in_a):
                    continue
                hit_q = in_q and scope in ("q", "all")
                hit_a = in_a and scope in ("a", "all")
                where = "Question + answer" if (hit_q and hit_a) else ("Question" if hit_q else "Answer")
                out.append({
                    "session_id": chat["id"],
                    "title": chat.get("title") or "",
                    "seq": turn.get("seq"),
                    "q_id": turn.get("q_id"),
                    "ts": turn.get("ts"),
                    "where": where,
                    "steer": bool(turn.get("steer")),
                    "q_preview": preview(turn.get("q") or "", 70),
                    "image_count": len(turn.get("q_images") or []),
                    "a_preview": preview(turn.get("answer") or "", 90),
                })
                if len(out) >= limit:
                    return out
        return out

    def find_attachment(self, sid: str, attachment_id: str) -> Path | None:
        """Best-effort lookup for an image attachment id in known DSH stores."""
        safe = re.sub(r"[^A-Za-z0-9_.-]", "", attachment_id or "")
        if not safe or safe in (".", "..") or safe.startswith("."):
            return None
        roots = []
        chat = self.chat(sid) if sid else None
        if chat and chat.get("path"):
            roots.append(Path(chat["path"]).parent)
        roots.extend([
            self.home / "attachments",
            self.home / "media",
            self.home / "storages" / "attachments",
            self.home / "storages" / "media",
            self.home / "storages" / "files",
        ])
        for root in roots:
            try:
                if not root.is_dir():
                    continue
                direct = [p for p in root.glob(f"{safe}.*") if p.is_file()]
                if direct:
                    return direct[0]
                nested = [
                    p for p in root.rglob(f"{safe}*")
                    if p.is_file() and p.suffix.lower() in IMAGE_EXT
                ]
                if nested:
                    return nested[0]
            except OSError:
                continue
        return None
