"""Build a small synthetic DSH home for tests (no real ~/.dsh data needed)."""

from __future__ import annotations

import json
from pathlib import Path

from compression import zstd

SID = "session-test-0001"
CWD = r"C:\Users\test\project"


def ev(etype: str, seq: int, time: int, data: dict, **extra) -> dict:
    row = {"type": etype, "seq": seq, "time": time, "data": data}
    row.update(extra)
    return row


def default_events() -> list[dict]:
    t0 = 1_800_000_000_000
    return [
        ev("turn/start", 1, t0, {"turn": 1}),
        ev("user/message", 2, t0 + 10, {
            "role": "user",
            "source": {"kind": "user", "rpcId": "rpc-1"},
            "content": [{"type": "text", "text": "第一轮问题：列一下文件。"}],
        }, surfaceOp="append"),
        ev("system/message", 3, t0 + 11, {
            "turn": 1, "step": 1,
            "message": {"role": "system", "content": [{"type": "text", "text": "You are a test agent."}]},
        }, surfaceOp="append"),
        ev("assistant/message", 4, t0 + 20, {
            "turn": 1, "step": 1,
            "message": {"role": "assistant", "content": [
                {"type": "reasoning", "text": "先想一下：需要列目录。"},
                {"type": "text", "text": "第一轮回答的第一段。"},
                {"type": "tool-call", "id": "call-1", "name": "pwsh",
                 "arguments": json.dumps({"command": "Get-ChildItem", "description": "列出文件"}, ensure_ascii=False)},
            ]},
        }),
        ev("tool/call", 5, t0 + 21, {
            "turn": 1, "step": 1, "callId": "call-1", "name": "pwsh",
            "arguments": json.dumps({"command": "Get-ChildItem", "description": "列出文件"}, ensure_ascii=False),
        }),
        ev("job/registered", 6, t0 + 22, {
            "jobId": "job-1", "kind": "pwsh",
            "toolCall": {"callId": "call-1", "rootCallId": "call-1"},
            "startedAt": t0 + 22,
        }),
        ev("job/settled", 7, t0 + 122, {
            "jobId": "job-1", "kind": "pwsh",
            "toolCall": {"callId": "call-1", "rootCallId": "call-1"},
            "startedAt": t0 + 22, "finishedAt": t0 + 122,
            "status": "completed", "detail": "exit code: 1",
        }),
        ev("tool/result", 8, t0 + 123, {
            "turn": 1, "step": 1,
            "message": {
                "role": "tool", "toolCallId": "call-1", "isError": True,
                "source": {"kind": "tool", "callId": "call-1"},
                "content": [{"type": "text", "text": "hello\n[stderr]\nboom\n[exit code: 1]"}],
            },
        }, surfaceOp="append"),
        # injected runtime context: not a question, must not split the answer
        ev("user/message", 9, t0 + 124, {
            "role": "user",
            "source": {"kind": "runtime-context", "form": "snapshot"},
            "content": [{"type": "text", "text": "Current runtime context. This snapshot supersedes ..."}],
        }, surfaceOp="append"),
        ev("assistant/message", 10, t0 + 130, {
            "turn": 1, "step": 1,
            "message": {"role": "assistant", "content": [
                {"type": "text", "text": "第一轮回答的第二段。"},
                {"type": "tool-call", "id": "call-2", "name": "read",
                 "arguments": json.dumps({"file_path": r"C:\x\a.py"}, ensure_ascii=False)},
            ]},
        }),
        ev("tool/call", 11, t0 + 131, {
            "turn": 1, "step": 1, "callId": "call-2", "name": "read",
            "arguments": json.dumps({"file_path": r"C:\x\a.py"}, ensure_ascii=False),
        }),
        ev("tool/result", 12, t0 + 132, {
            "turn": 1, "step": 1,
            "message": {
                "role": "tool", "toolCallId": "call-2",
                "source": {"kind": "tool", "callId": "call-2"},
                "content": [{"type": "text", "text":
                    "<path>C:\\x\\a.py</path>\n<type>file</type>\n<content>\n"
                    "1: print(1)\n2: print(2)\n</content>"}],
            },
        }, surfaceOp="append"),
        ev("assistant/message", 13, t0 + 140, {
            "turn": 1, "step": 1,
            "message": {"role": "assistant", "content": [
                {"type": "tool-call", "id": "call-3", "name": "ask_user_question",
                 "arguments": json.dumps({"questions": [
                     {"id": "scope", "header": "范围", "question": "选哪个？",
                      "options": [{"label": "A", "description": "选项 A"}, {"label": "B"}]},
                     {"id": "note", "header": "补充", "question": "还有吗？", "options": []},
                 ]}, ensure_ascii=False)},
            ]},
        }),
        ev("tool/call", 14, t0 + 141, {
            "turn": 1, "step": 1, "callId": "call-3", "name": "ask_user_question",
            "arguments": json.dumps({"questions": [
                {"id": "scope", "header": "范围", "question": "选哪个？",
                 "options": [{"label": "A", "description": "选项 A"}, {"label": "B"}]},
                {"id": "note", "header": "补充", "question": "还有吗？", "options": []},
            ]}, ensure_ascii=False),
        }),
        ev("tool/result", 15, t0 + 142, {
            "turn": 1, "step": 1,
            "message": {
                "role": "tool", "toolCallId": "call-3",
                "source": {"kind": "tool", "callId": "call-3"},
                "content": [{"type": "text", "text": json.dumps({
                    "answers": [
                        {"id": "scope", "selected": ["A"]},
                        {"id": "note", "selected": [], "custom": "自定义回答"},
                    ]
                }, ensure_ascii=False)}],
            },
        }, surfaceOp="append"),
        ev("assistant/message", 16, t0 + 150, {
            "turn": 1, "step": 1,
            "message": {"role": "assistant", "content": [
                {"type": "tool-call", "id": "call-4", "name": "todo_write",
                 "arguments": json.dumps({"todos": [
                     {"content": "A", "status": "completed"},
                     {"content": "B", "status": "in_progress"},
                 ]}, ensure_ascii=False)},
            ]},
        }),
        ev("tool/call", 17, t0 + 151, {
            "turn": 1, "step": 1, "callId": "call-4", "name": "todo_write",
            "arguments": json.dumps({"todos": [
                {"content": "A", "status": "completed"},
                {"content": "B", "status": "in_progress"},
            ]}, ensure_ascii=False),
        }),
        ev("tool/result", 18, t0 + 152, {
            "turn": 1, "step": 1,
            "message": {
                "role": "tool", "toolCallId": "call-4",
                "source": {"kind": "tool", "callId": "call-4"},
                "content": [{"type": "text", "text": "Updated todo list: 1 completed, 1 in progress."}],
            },
        }, surfaceOp="append"),
        ev("turn/end", 19, t0 + 160, {"turn": 1, "reason": {"kind": "completed"}}),
        ev("turn/start", 20, t0 + 200, {"turn": 2}),
        ev("user/message", 21, t0 + 210, {
            "role": "user",
            "source": {"kind": "user", "rpcId": "rpc-2"},
            "content": [{"type": "text", "text": "第二轮问题：简短回答。"}],
        }, surfaceOp="append"),
        ev("assistant/message", 22, t0 + 220, {
            "turn": 2, "step": 1,
            "message": {"role": "assistant", "content": [{"type": "text", "text": "第二轮回答。"}]},
        }),
        ev("turn/end", 23, t0 + 230, {"turn": 2, "reason": {"kind": "completed"}}),
        ev("session/title", 24, t0 + 300, {"title": "测试会话", "messageSeqs": [2]}),
    ]


def steer_events() -> list[dict]:
    t0 = 1_800_000_100_000
    return [
        ev("turn/start", 1, t0, {"turn": 1}),
        ev("user/message", 2, t0 + 10, {
            "role": "user", "source": {"kind": "user"},
            "content": [{"type": "text", "text": "原始问题。"}],
        }, surfaceOp="append"),
        ev("assistant/message", 3, t0 + 20, {
            "turn": 1, "step": 1,
            "message": {"role": "assistant", "content": [{"type": "text", "text": "原始回答。"}]},
        }),
        # A mid-turn steer arrives without a new turn/start.
        ev("user/message", 4, t0 + 30, {
            "role": "user", "source": {"kind": "user"},
            "content": [{"type": "text", "text": "中途插话。"}],
        }, surfaceOp="append"),
        ev("assistant/message", 5, t0 + 40, {
            "turn": 1, "step": 1,
            "message": {"role": "assistant", "content": [{"type": "text", "text": "对插话的回答。"}]},
        }),
        ev("turn/end", 6, t0 + 50, {"turn": 1, "reason": {"kind": "completed"}}),
    ]


def write_session(
    root: Path,
    events: list[dict] | None = None,
    *,
    sid: str = SID,
    cwd: str = CWD,
    torn_tail: bool = False,
    split_frames: bool = True,
    title: str = "缓存标题",
    pinned: bool = True,
    archived: bool = False,
) -> Path:
    root = Path(root)
    events = default_events() if events is None else events
    header = {
        "type": "session", "version": 4, "id": sid, "createdAt": 1_800_000_000_000,
        "cwd": cwd, "isSeeded": False, "delegationDepth": 0, "agentPreset": "standard",
    }
    rows = [header, *events]
    frames = []
    for row in rows:
        raw = json.dumps(row, ensure_ascii=False).encode("utf-8") + b"\n"
        frames.append(zstd.compress(raw))
    if not split_frames:
        frames = [zstd.compress(b"\n".join(
            json.dumps(row, ensure_ascii=False).encode("utf-8") for row in rows
        ) + b"\n")]
    blob = b"".join(frames)
    if torn_tail:
        blob += b"\x28\xb5\x2f\xfd\x00\x00torn"
    session_dir = root / "sessions" / "--C-Users-test-project--" / sid
    session_dir.mkdir(parents=True, exist_ok=True)
    path = session_dir / "session.v4.jsonl.zstd"
    path.write_bytes(blob)

    (root / "storages" / "session_projcache" / "sessions").mkdir(parents=True, exist_ok=True)
    proj = {
        "version": 7,
        "record": {"rows": {
            "title": {"ver": 1, "seq": 1, "val": title},
            "tokenUsage": {"ver": 2, "seq": 1, "val": {"totals": {
                "uncachedInputTokens": 1000, "outputTokens": 200,
                "cacheReadTokens": 300, "cacheWriteTokens": 0,
            }}},
            "sessionStats": {"ver": 1, "seq": 1, "val": {"turns": 2, "steps": 3}},
            "modelSelection": {"ver": 2, "seq": 1, "val": {"lastUsed": {
                "provider": "deepseek-account", "model": "deepseek-flash",
            }}},
            "workingDirectory": {"ver": 1, "seq": 1, "val": cwd},
        }},
    }
    (root / "storages" / "session_projcache" / "sessions" / f"{sid}.json").write_text(
        json.dumps(proj, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    workspace = {
        "unit": {"name": "workspace", "version": 2},
        "global": {
            "initialized": True,
            "workspaceIds": ["ws-1"],
            "archivedSessionIds": [sid] if archived else [],
            "pinnedSessionIds": [sid] if pinned else [],
            "defaultWorkspaceId": "ws-1",
        },
        "tables": {"workspaces": {"ws-1": {
            "path": cwd, "title": "test-project",
            "sessionIds": [sid],
            "createdAt": "2026-10-20T00:00:00.000Z",
            "updatedAt": "2026-10-20T00:00:00.000Z",
        }}},
    }
    (root / "storages").mkdir(parents=True, exist_ok=True)
    (root / "storages" / "workspace.json").write_text(
        json.dumps(workspace, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    return path
