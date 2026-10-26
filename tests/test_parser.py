#!/usr/bin/env python3
"""Parser regression tests for DSH Chat Viewer.

Run with the same Python that runs the viewer:

    C:\\pixi_env\\.pixi\\envs\\default\\python.exe tests\\test_parser.py
"""

from __future__ import annotations

import sys
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(ROOT))

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

from fixture import SID, steer_events, write_session  # noqa: E402
from lib.dsh import Store, build_session, calls_payload, parse_session_file  # noqa: E402


def payload(turn: dict, name: str) -> dict:
    for call in calls_payload(turn):
        if call.get("name") == name:
            return call
    raise AssertionError(f"no tool call named {name}")


class BuildSessionTests(unittest.TestCase):
    def _session(self, events=None, torn=False, split=True):
        with tempfile.TemporaryDirectory() as tmp:
            home = Path(tmp)
            path = write_session(home, events, torn_tail=torn, split_frames=split)
            parsed = parse_session_file(path)
        self.assertIsNotNone(parsed)
        return parsed

    def test_default_two_turns(self):
        s = self._session()
        self.assertEqual(s["id"], SID)
        self.assertEqual(s["title"], "测试会话")
        self.assertEqual(len(s["turns"]), 2)
        q1, q2 = s["turns"]
        self.assertEqual(q1["q"], "第一轮问题：列一下文件。")
        self.assertEqual(q2["q"], "第二轮问题：简短回答。")
        # The injected runtime-context message must not split the first answer.
        self.assertEqual(q1["answer"],
                         "第一轮回答的第一段。\n\n第一轮回答的第二段。")
        self.assertEqual(q2["answer"], "第二轮回答。")
        self.assertFalse(q1["steer"])
        self.assertFalse(q1["open"])
        self.assertFalse(q2["open"])
        self.assertEqual(q1["reasoning"][0]["text"], "先想一下：需要列目录。")
        self.assertEqual(len(q1["calls"]), 4)

    def test_pwsh_result(self):
        s = self._session()
        call = payload(s["turns"][0], "pwsh")
        result = call["result"]
        self.assertEqual(result["exit_code"], 1)
        self.assertTrue(result["is_error"])
        self.assertEqual(call["job"]["status"], "completed")
        self.assertEqual(call["job"]["duration_ms"], 100)
        labels = [p["label"] for p in result["parts"]]
        self.assertIn("Output", labels)
        self.assertIn("stderr", labels)
        self.assertEqual(call["summary"], "列出文件")

    def test_read_result(self):
        s = self._session()
        call = payload(s["turns"][0], "read")
        self.assertEqual(call["summary"], r"C:\x\a.py")
        result = call["result"]
        self.assertEqual(result["path"], r"C:\x\a.py")
        self.assertEqual(result["parts"][0]["text"], "print(1)\nprint(2)")
        self.assertEqual(result["line_range"]["start"], 1)
        self.assertEqual(result["line_range"]["end"], 2)

    def test_ask_user_question(self):
        s = self._session()
        call = payload(s["turns"][0], "ask_user_question")
        self.assertEqual(len(call["questions"]), 2)
        self.assertEqual(call["questions"][0]["selected"], ["A"])
        self.assertEqual(call["questions"][1]["custom"], "自定义回答")
        self.assertEqual(call["result"]["parts"], [])

    def test_todo_write(self):
        s = self._session()
        call = payload(s["turns"][0], "todo_write")
        self.assertEqual([t["status"] for t in call["todos"]], ["completed", "in_progress"])
        self.assertEqual([t["content"] for t in call["todos"]], ["A", "B"])

    def test_single_frame_and_torn_tail(self):
        s = self._session(split=False)
        self.assertEqual(len(s["turns"]), 2)
        s = self._session(torn=True)
        self.assertEqual(len(s["turns"]), 2)
        self.assertEqual(s["turns"][0]["answer"],
                         "第一轮回答的第一段。\n\n第一轮回答的第二段。")

    def test_truncated_final_frame_keeps_prefix(self):
        # This is the shape of a live session being appended to: the last
        # Zstandard frame is cut off.  ZstdFile yields the complete prefix and
        # raises EOFError; the viewer must keep the prefix.
        with tempfile.TemporaryDirectory() as tmp:
            home = Path(tmp)
            path = write_session(home)
            data = path.read_bytes()
            path.write_bytes(data[:-100])
            parsed = parse_session_file(path)
        self.assertIsNotNone(parsed)
        self.assertEqual(len(parsed["turns"]), 2)
        self.assertEqual(parsed["turns"][0]["answer"],
                         "第一轮回答的第一段。\n\n第一轮回答的第二段。")

    def test_steer(self):
        s = self._session(steer_events())
        self.assertEqual(len(s["turns"]), 2)
        first, second = s["turns"]
        self.assertEqual(first["q"], "原始问题。")
        self.assertEqual(first["answer"], "原始回答。")
        self.assertTrue(second["steer"])
        self.assertEqual(second["q"], "中途插话。")
        self.assertEqual(second["answer"], "对插话的回答。")

    def test_automatic_continuation(self):
        header = {"type": "session", "version": 4, "id": "s", "createdAt": 1, "cwd": r"C:\x"}
        events = [
            {"type": "turn/start", "seq": 1, "time": 1, "data": {"turn": 1}},
            {"type": "user/message", "seq": 2, "time": 2, "data": {
                "role": "user", "source": {"kind": "user"},
                "content": [{"type": "text", "text": "第一问"}],
            }},
            {"type": "assistant/message", "seq": 3, "time": 3, "data": {
                "turn": 1, "step": 1,
                "message": {"role": "assistant", "content": [{"type": "text", "text": "第一答"}]},
            }},
            {"type": "turn/end", "seq": 4, "time": 4, "data": {"turn": 1}},
            # A new turn starts without a human message (goal continuation).
            {"type": "turn/start", "seq": 5, "time": 5, "data": {"turn": 2}},
            {"type": "assistant/message", "seq": 6, "time": 6, "data": {
                "turn": 2, "step": 1,
                "message": {"role": "assistant", "content": [{"type": "text", "text": "自动继续的答"}]},
            }},
            {"type": "turn/end", "seq": 7, "time": 7, "data": {"turn": 2}},
        ]
        session = build_session("s", header, events)
        self.assertEqual(len(session["turns"]), 2)
        first, second = session["turns"]
        self.assertEqual(first["answer"], "第一答")
        self.assertTrue(second["synthetic"])
        self.assertEqual(second["synthetic_kind"], "auto")
        self.assertEqual(second["q"], "")
        self.assertEqual(second["answer"], "自动继续的答")


class StoreTests(unittest.TestCase):
    def test_chats_and_metadata(self):
        with tempfile.TemporaryDirectory() as tmp:
            home = Path(tmp)
            write_session(home, pinned=True, archived=False)
            store = Store(home)
            meta = store.meta()
            self.assertEqual(meta["sessions"], 1)
            self.assertEqual(meta["questions"], 2)
            chats = store.chats()
            self.assertEqual(len(chats), 1)
            chat = chats[0]
            # Listing uses metadata only: the projection cache title is shown
            # until the full log is opened.
            self.assertEqual(chat["title"], "缓存标题")
            self.assertFalse(chat["loaded"])
            self.assertEqual(chat["questions"], 2)
            self.assertTrue(chat["pinned"])
            self.assertFalse(chat["archived"])
            self.assertEqual(chat["workspace"]["title"], "test-project")
            self.assertEqual(chat["tokens"]["outputTokens"], 200)
            # Opening the session parses it once and refines the metadata.
            self.assertEqual(store.turns(SID)[0]["q"], "第一轮问题：列一下文件。")
            self.assertTrue(chat["loaded"])
            self.assertEqual(chat["title"], "测试会话")
            self.assertEqual(chat["answered"], 2)
            self.assertGreater(chat["message_count"], 0)
            self.assertEqual(store.meta()["loaded"], 1)
            self.assertEqual(store.turn(SID, 2)["q"], "第一轮问题：列一下文件。")
            self.assertIsNone(store.turn(SID, 999))

    def test_empty_home(self):
        with tempfile.TemporaryDirectory() as tmp:
            store = Store(Path(tmp))
            self.assertEqual(store.meta()["sessions"], 0)
            self.assertEqual(store.chats(), [])

    def test_search(self):
        with tempfile.TemporaryDirectory() as tmp:
            home = Path(tmp)
            write_session(home)
            store = Store(home)
            hits = store.search("第二轮", None, "all", 50)
            self.assertEqual(len(hits), 1)
            self.assertEqual(hits[0]["where"], "Question + answer" if "第二轮" in hits[0]["a_preview"] else "Question")


class ImageTests(unittest.TestCase):
    def test_image_blocks_and_markers(self):
        header = {"type": "session", "version": 4, "id": "s", "createdAt": 1, "cwd": r"C:\x"}
        events = [
            {"type": "turn/start", "seq": 1, "time": 1, "data": {"turn": 1}},
            {"type": "user/message", "seq": 2, "time": 2, "data": {
                "role": "user", "source": {"kind": "user"},
                "content": [
                    {"type": "text", "text": "看这张图 @image:C:\\tmp\\a.png [screenshot]"},
                    {"type": "image", "path": r"C:\tmp\b.png"},
                ],
            }},
            {"type": "assistant/message", "seq": 3, "time": 3, "data": {
                "turn": 1, "step": 1,
                "message": {"role": "assistant", "content": [{"type": "text", "text": "OK"}]},
            }},
            {"type": "turn/end", "seq": 4, "time": 4, "data": {"turn": 1}},
        ]
        session = build_session("s", header, events)
        turn = session["turns"][0]
        self.assertEqual(turn["q"], "看这张图")
        self.assertEqual([i["path"] for i in turn["q_images"]], [r"C:\tmp\a.png", r"C:\tmp\b.png"])

    def test_compaction_summary(self):
        header = {"type": "session", "version": 4, "id": "s", "createdAt": 1, "cwd": r"C:\x"}
        events = [
            {"type": "turn/start", "seq": 1, "time": 1, "data": {"turn": 1}},
            {"type": "user/message", "seq": 2, "time": 2, "data": {
                "role": "user", "source": {"kind": "user"},
                "content": [{"type": "text", "text": "问题"}],
            }},
            {"type": "compaction/summary", "seq": 3, "time": 3, "data": {
                "summary": [{"type": "text", "text": "这是压缩摘要。"}],
            }},
            {"type": "assistant/message", "seq": 4, "time": 4, "data": {
                "turn": 1, "step": 1,
                "message": {"role": "assistant", "content": [{"type": "text", "text": "回答"}]},
            }},
            {"type": "turn/end", "seq": 5, "time": 5, "data": {"turn": 1}},
        ]
        session = build_session("s", header, events)
        turn = session["turns"][0]
        self.assertEqual(turn["compactions"][0]["text"], "这是压缩摘要。")


if __name__ == "__main__":
    unittest.main(verbosity=2)
