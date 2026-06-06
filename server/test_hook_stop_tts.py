"""Unit tests for server/hook_stop_tts.py.

Run locally on Windows:

    py -3 -m unittest -v server.test_hook_stop_tts
"""

from __future__ import annotations

import json
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent))
import hook_stop_tts


class HookStopTtsTests(unittest.TestCase):
    def test_extract_response_text_prefers_final_message_without_tool_requests(self) -> None:
        entries = [
            {"type": "user.message", "data": {"content": "question"}},
            {
                "type": "assistant.message",
                "data": {
                    "content": "tool call message",
                    "toolRequests": [{"toolName": "example"}],
                },
            },
            {
                "type": "assistant.message",
                "data": {
                    "content": "Final answer with `inline` and [link](https://example.com)",
                    "toolRequests": [],
                },
            },
        ]

        text = hook_stop_tts.extract_response_text(entries)

        self.assertEqual(text, "Final answer with inline and link")

    def test_load_session_label_reads_stored_label(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_dir:
            tmp = Path(tmp_dir)
            session_labels = tmp / "session-labels.json"
            log_file = tmp / "hook.log"

            session_labels.write_text(
                json.dumps(
                    {
                        "sessions": {
                            "session-1": {
                                "label": "Release planning",
                                "updatedAt": "2026-06-04T00:00:00Z",
                            }
                        }
                    }
                ),
                encoding="utf-8",
            )

            chat_name = hook_stop_tts.load_session_label(
                str(session_labels),
                "session-1",
                str(log_file),
            )

            self.assertEqual(chat_name, "Release planning")
        self.assertEqual(
            hook_stop_tts.prefix_with_chat_name("Final answer", chat_name),
            "Chat: Release planning. Final answer",
        )

    def test_play_audio_detached_windows_writes_playing_state(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_dir:
            tmp = Path(tmp_dir)
            playback_state = tmp / "playback.json"
            log_file = tmp / "hook.log"

            fake_process = SimpleNamespace(pid=4321)

            with patch(
                "server.hook_stop_tts.platform.system",
                return_value="Windows",
            ), patch(
                "server.hook_stop_tts.subprocess.Popen",
                return_value=fake_process,
            ) as popen_mock:
                hook_stop_tts.play_audio_detached(
                    b"RIFFFAKEWAVE",
                    speed=1.25,
                    playback_state_file=str(playback_state),
                    log_path=str(log_file),
                )

            self.assertTrue(popen_mock.called)
            self.assertTrue(playback_state.exists())

            payload = json.loads(playback_state.read_text(encoding="utf-8"))
            self.assertEqual(payload.get("stage"), "playing")
            self.assertEqual(payload.get("pid"), 4321)
            self.assertTrue(isinstance(payload.get("wavPath"), str))
            self.assertNotEqual(payload.get("wavPath"), "")
            popen_args = popen_mock.call_args[0][0]
            self.assertIn("-c", popen_args)
            self.assertIn(
                Path(popen_args[0]).name.lower(),
                {Path(sys.executable).name.lower(), "pythonw.exe"},
            )

    def test_play_audio_detached_windows_without_python_executable_logs_error(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_dir:
            tmp = Path(tmp_dir)
            playback_state = tmp / "playback.json"
            log_file = tmp / "hook.log"

            with patch(
                "server.hook_stop_tts.platform.system",
                return_value="Windows",
            ), patch(
                "server.hook_stop_tts.sys.executable",
                "",
            ), patch("server.hook_stop_tts.subprocess.Popen") as popen_mock:
                hook_stop_tts.play_audio_detached(
                    b"RIFFFAKEWAVE",
                    speed=1.0,
                    playback_state_file=str(playback_state),
                    log_path=str(log_file),
                )

            self.assertFalse(popen_mock.called)
            self.assertFalse(playback_state.exists())
            self.assertTrue(log_file.exists())
            log_text = log_file.read_text(encoding="utf-8")
            self.assertIn("cannot launch detached Windows playback worker", log_text)


if __name__ == "__main__":
    unittest.main()
