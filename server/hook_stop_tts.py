#!/usr/bin/env python3

import argparse
import hashlib
import json
import os
import platform
import re
import shlex
import sqlite3
import subprocess
import sys
import tempfile
import urllib.error
import urllib.request
from datetime import datetime, timezone


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Copilot TTS Stop hook runner")
    parser.add_argument("--payload-file")
    parser.add_argument("--log", required=True)
    parser.add_argument("--state-dir", required=True)
    parser.add_argument("--last-response-file", required=True)
    parser.add_argument("--session-cache-file", required=True)
    parser.add_argument("--session-labels-file", required=True)
    parser.add_argument("--settings-file", required=True)
    parser.add_argument("--playback-state-file", required=True)
    parser.add_argument("--vscode-session-id", default="")
    return parser.parse_args()


def log_line(path: str, message: str) -> None:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    stamp = datetime.now(timezone.utc).isoformat()
    with open(path, "a", encoding="utf-8") as handle:
        handle.write(f"[{stamp}] {message}\n")


def load_payload(log_path: str, payload_file: str | None = None) -> dict:
    raw = ""
    if payload_file:
        try:
            with open(payload_file, "r", encoding="utf-8-sig") as handle:
                raw = handle.read()
        except OSError as exc:
            log_line(log_path, f"failed to read payload file {payload_file}: {exc}")
            return {}
        finally:
            try:
                os.unlink(payload_file)
            except OSError:
                pass
    else:
        raw = sys.stdin.read()

    if not raw.strip():
        log_line(log_path, "hook payload was empty")
        return {}
    try:
        payload = json.loads(raw)
        log_line(log_path, f"received hook payload keys={sorted(payload.keys())}")
        return payload
    except json.JSONDecodeError as exc:
        log_line(log_path, f"failed to decode hook payload JSON: {exc}")
        return {}


def parse_jsonl(path: str, log_path: str) -> list[dict]:
    entries: list[dict] = []
    try:
        with open(path, "r", encoding="utf-8") as handle:
            for line_number, line in enumerate(handle, start=1):
                text = line.strip()
                if not text:
                    continue
                try:
                    entries.append(json.loads(text))
                except json.JSONDecodeError as exc:
                    log_line(log_path, f"invalid transcript JSON at line {line_number}: {exc}")
    except OSError as exc:
        log_line(log_path, f"failed to read transcript {path}: {exc}")
    return entries


def extract_response_text(entries: list[dict]) -> str:
    last_user_index = -1
    for index, entry in enumerate(entries):
        if entry.get("type") == "user.message":
            last_user_index = index

    final_messages: list[str] = []
    fallback_messages: list[str] = []

    for entry in entries[last_user_index + 1 :]:
        if entry.get("type") != "assistant.message":
            continue
        data = entry.get("data") or {}
        content = str(data.get("content") or "").strip()
        if not content:
            continue
        fallback_messages.append(content)
        tool_requests = data.get("toolRequests") or []
        if not tool_requests:
            final_messages.append(content)

    selected = final_messages or fallback_messages[-1:]
    combined = "\n\n".join(selected)
    return cleanup_markdown(combined)


def load_session_label(path: str, session_id: str, log_path: str) -> str | None:
    try:
        with open(path, "r", encoding="utf-8") as handle:
            payload = json.load(handle)
    except OSError:
        return None
    except json.JSONDecodeError as exc:
        log_line(log_path, f"failed to decode session labels file {path}: {exc}")
        return None

    sessions = payload.get("sessions") if isinstance(payload, dict) else None
    if not isinstance(sessions, dict):
        return None

    entry = sessions.get(session_id)
    if not isinstance(entry, dict):
        return None

    label = str(entry.get("label") or "").strip()
    return label or None


def load_session_label_from_vscode_db(session_id: str, transcript_path: str, log_path: str) -> str | None:
    """Fall back to reading the chat session title from VS Code's workspace-state SQLite DB.

    Path derivation:
        transcript_path  …/workspaceStorage/<hash>/GitHub.copilot-chat/transcripts/<uuid>.jsonl
        state.vscdb      …/workspaceStorage/<hash>/state.vscdb   (two directories up)

    VS Code stores all standard chat-session titles under the key
    ``chat.ChatSessionStore.index`` in the shared ``ItemTable``.
    """
    try:
        db_path = os.path.join(
            os.path.dirname(os.path.dirname(os.path.dirname(transcript_path))),
            "state.vscdb",
        )
        if not os.path.isfile(db_path):
            log_line(log_path, f"state.vscdb not found at {db_path}")
            return None
        conn = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True, timeout=2)
        try:
            row = conn.execute(
                "SELECT value FROM ItemTable WHERE key = 'chat.ChatSessionStore.index'"
            ).fetchone()
        finally:
            conn.close()
        if not row:
            log_line(log_path, "chat.ChatSessionStore.index not found in state.vscdb")
            return None
        data = json.loads(row[0])
        entry = data.get("entries", {}).get(session_id, {})
        title = str(entry.get("title") or "").strip()
        if title:
            log_line(log_path, f"loaded session title from VS Code DB: {title!r} for {session_id}")
            return title
        log_line(log_path, f"no title found in state.vscdb for session {session_id}")
    except Exception as exc:
        log_line(log_path, f"load_session_label_from_vscode_db failed: {exc}")
    return None


def prefix_with_chat_name(text: str, chat_name: str | None) -> str:
    if not chat_name:
        return text

    separator = " " if chat_name.endswith(("...", ".", "!", "?")) else ". "
    return f"Chat: {chat_name}{separator}{text}"


def cleanup_markdown(text: str) -> str:
    text = re.sub(r"```[\s\S]*?```", " ", text)
    text = re.sub(r"`([^`]+)`", r"\1", text)
    text = re.sub(r"\[([^\]]+)\]\([^\)]+\)", r"\1", text)
    text = re.sub(r"^[>#*-]\s*", "", text, flags=re.MULTILINE)
    text = re.sub(r"\s+", " ", text)
    return text.strip()


def already_spoken(state_dir: str, session_id: str, text: str, log_path: str) -> bool:
    os.makedirs(state_dir, exist_ok=True)
    digest = hashlib.sha256(text.encode("utf-8")).hexdigest()
    state_path = os.path.join(state_dir, f"{session_id}.json")

    try:
        with open(state_path, "r", encoding="utf-8") as handle:
            data = json.load(handle)
        if data.get("digest") == digest:
            log_line(log_path, f"response already spoken for session {session_id}")
            return True
    except OSError:
        pass
    except json.JSONDecodeError:
        pass

    with open(state_path, "w", encoding="utf-8") as handle:
        json.dump({"digest": digest}, handle)
    return False


def load_runtime_settings(path: str, log_path: str) -> dict:
    try:
        with open(path, "r", encoding="utf-8") as handle:
            payload = json.load(handle)
        settings = {
            "port": int(payload.get("port", 8765)),
            "voice": str(payload.get("voice", "M1")),
            "language": str(payload.get("language", "en")),
            "speed": float(payload.get("speed", 1.0)),
        }
        log_line(log_path, f"loaded runtime settings voice={settings['voice']} language={settings['language']} speed={settings['speed']} port={settings['port']}")
        return settings
    except Exception as exc:
        log_line(log_path, f"failed to load runtime settings from {path}: {exc}")
        return {
            "port": 8765,
            "voice": "M1",
            "language": "en",
            "speed": 1.0,
        }


def synthesize(port: int, voice: str, language: str, speed: float, text: str, log_path: str) -> bytes | None:
    payload = json.dumps(
        {
            "text": text,
            "voice": voice,
            "lang": language,
            "speed": speed,
        }
    ).encode("utf-8")
    request = urllib.request.Request(
        f"http://127.0.0.1:{port}/synthesize",
        data=payload,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            audio = response.read()
            log_line(log_path, f"synthesized {len(audio)} bytes of audio")
            return audio
    except (urllib.error.URLError, TimeoutError) as exc:
        log_line(log_path, f"synthesis request failed: {exc}")
        return None


def load_window_claim_session_id(transcript_path: str, log_path: str) -> str:
    """Derive the authoritative vsCodeSessionId from the workspace-specific claim file.

    Path derivation (3 dirname calls from transcript):
        transcript  …/workspaceStorage/<hash>/GitHub.copilot-chat/transcripts/<uuid>.jsonl
        claim file  …/workspaceStorage/<hash>/pavel-piha.copilot-tts/tts-window-claim.json

    This file is written by each VS Code window on activation and contains
    { "vsCodeSessionId": "<id>" }.  Using it ensures that even when multiple
    windows share the same global hook file (and one window's session ID was
    baked into the command), we always stamp the response with the session ID
    of the window that actually owns the workspace where the chat occurred.
    """
    workspace_hash_dir = os.path.dirname(
        os.path.dirname(os.path.dirname(str(transcript_path)))
    )
    claim_path = os.path.join(
        workspace_hash_dir, "pavel-piha.copilot-tts", "tts-window-claim.json"
    )
    try:
        with open(claim_path, "r", encoding="utf-8") as handle:
            data = json.load(handle)
        session_id = str(data.get("vsCodeSessionId") or "").strip()
        if session_id:
            log_line(
                log_path,
                f"window claim vsCodeSessionId={session_id} from {claim_path}",
            )
            return session_id
    except (OSError, json.JSONDecodeError) as exc:
        log_line(log_path, f"could not read window claim file {claim_path}: {exc}")
    return ""


def store_last_response(path: str, session_id: str, text: str, log_path: str, vscode_session_id: str = "", chat_name: str = "") -> None:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    payload = {
        "sessionId": session_id,
        "vsCodeSessionId": vscode_session_id,
        "chatName": chat_name,
        "text": text,
        "updatedAt": datetime.now(timezone.utc).isoformat(),
    }
    with open(path, "w", encoding="utf-8") as handle:
        json.dump(payload, handle)
    log_line(log_path, f"stored replay text at {path}")


def store_session_response(path: str, session_id: str, text: str, log_path: str) -> None:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    payload = {"sessions": {}}
    try:
        with open(path, "r", encoding="utf-8") as handle:
            loaded = json.load(handle)
        if isinstance(loaded, dict):
            payload.update(loaded)
    except OSError:
        pass
    except json.JSONDecodeError:
        pass

    sessions = payload.get("sessions")
    if not isinstance(sessions, dict):
        sessions = {}

    sessions[session_id] = {
        "text": text,
        "updatedAt": datetime.now(timezone.utc).isoformat(),
    }

    if len(sessions) > 50:
        ordered = sorted(
            sessions.items(),
            key=lambda item: str(item[1].get("updatedAt", "")),
            reverse=True,
        )
        sessions = dict(ordered[:50])

    payload["sessions"] = sessions
    with open(path, "w", encoding="utf-8") as handle:
        json.dump(payload, handle)
    log_line(log_path, f"stored session replay text for session {session_id} at {path}")


def store_playback_state(path: str, pid: int, wav_path: str, log_path: str, vscode_session_id: str = "") -> None:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as handle:
        json.dump({"stage": "playing", "pid": pid, "wavPath": wav_path, "vsCodeSessionId": vscode_session_id}, handle)
    log_line(log_path, f"stored playback state stage=playing pid={pid} wav={wav_path}")


def store_synthesizing_state(path: str, log_path: str, vscode_session_id: str = "") -> None:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as handle:
        json.dump({"stage": "synthesizing", "vsCodeSessionId": vscode_session_id}, handle)
    log_line(log_path, "stored playback state stage=synthesizing")


def should_cancel_playback(path: str) -> bool:
    try:
        with open(path, "r", encoding="utf-8") as handle:
            payload = json.load(handle)
    except OSError:
        return True
    except json.JSONDecodeError:
        return True

    return payload.get("stage") == "cancelled"


def play_audio_detached(audio: bytes, speed: float, playback_state_file: str, log_path: str, vscode_session_id: str = "") -> None:
    with tempfile.NamedTemporaryFile(delete=False, suffix=".wav") as handle:
        handle.write(audio)
        wav_path = handle.name

    system = platform.system()

    if system == "Darwin":
        cleanup_cmd = (
            f"afplay -r {shlex.quote(str(speed))} {shlex.quote(wav_path)}; "
            f"rm -f {shlex.quote(wav_path)} {shlex.quote(playback_state_file)}"
        )
        process = subprocess.Popen(
            ["/bin/sh", "-c", cleanup_cmd],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            start_new_session=True,
        )
    elif system == "Windows":
        if not sys.executable:
            log_line(log_path, "sys.executable is empty; cannot launch detached Windows playback worker")
            try:
                os.remove(wav_path)
            except OSError:
                pass
            try:
                os.remove(playback_state_file)
            except OSError:
                pass
            return

        worker_executable = sys.executable
        if worker_executable.lower().endswith("python.exe"):
            candidate = worker_executable[:-10] + "pythonw.exe"
            if os.path.exists(candidate):
                worker_executable = candidate

        worker_code = "\n".join(
            [
                "import datetime",
                "import os",
                "import sys",
                "import winsound",
                "wav, state, log = sys.argv[1], sys.argv[2], sys.argv[3]",
                "def write_log(message):",
                "    stamp = datetime.datetime.now(datetime.timezone.utc).isoformat()",
                "    with open(log, 'a', encoding='utf-8') as handle:",
                "        handle.write(f'[{stamp}] {message}\\n')",
                "try:",
                "    winsound.PlaySound(wav, winsound.SND_FILENAME)",
                "except Exception as exc:",
                "    write_log(f'windows playback failed: {exc}')",
                "finally:",
                "    for path in (wav, state):",
                "        try:",
                "            os.unlink(path)",
                "        except OSError:",
                "            pass",
            ]
        )

        creationflags = 0
        creationflags |= getattr(subprocess, "DETACHED_PROCESS", 0)
        creationflags |= getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0)
        creationflags |= getattr(subprocess, "CREATE_NO_WINDOW", 0)

        process = subprocess.Popen(
            [
                worker_executable,
                "-c",
                worker_code,
                wav_path,
                playback_state_file,
                log_path,
            ],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            creationflags=creationflags,
            close_fds=True,
        )
    else:
        cleanup_cmd = (
            f"afplay {shlex.quote(wav_path)}; "
            f"rm -f {shlex.quote(wav_path)} {shlex.quote(playback_state_file)}"
        )
        process = subprocess.Popen(
            ["/bin/sh", "-c", cleanup_cmd],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            start_new_session=True,
        )

    store_playback_state(playback_state_file, process.pid, wav_path, log_path, vscode_session_id)
    log_line(log_path, f"spawned detached playback pid={process.pid} speed={speed} wav={wav_path}")


def main() -> None:
    args = parse_args()
    payload = load_payload(args.log, args.payload_file)
    settings = load_runtime_settings(args.settings_file, args.log)

    if payload.get("stop_hook_active"):
                log_line(args.log, "stop_hook_active=true; skipping speech")
                return

    transcript_path = payload.get("transcript_path")
    session_id = str(payload.get("session_id") or "unknown-session")
    if not transcript_path:
        log_line(args.log, "payload did not include transcript_path")
        return

    entries = parse_jsonl(str(transcript_path), args.log)
    if not entries:
        log_line(args.log, "no transcript entries available")
        return

    text = extract_response_text(entries)
    if not text:
        log_line(args.log, "no assistant text extracted from transcript")
        return

    # Prefer the authoritative VS Code DB title over the (potentially stale) JSON cache.
    chat_name = load_session_label_from_vscode_db(session_id, str(transcript_path), args.log)
    if chat_name is None:
        chat_name = load_session_label(args.session_labels_file, session_id, args.log)
    text = prefix_with_chat_name(text, chat_name)

    log_line(args.log, f"extracted {len(text)} chars for session {session_id}")
    if already_spoken(args.state_dir, session_id, text, args.log):
        return

    # Prefer the workspace-specific claim file over the baked-in arg so that
    # multi-window setups always stamp the correct window's session ID.
    effective_vscode_session_id = (
        load_window_claim_session_id(str(transcript_path), args.log)
        or args.vscode_session_id
    )

    store_last_response(args.last_response_file, session_id, text, args.log, effective_vscode_session_id, chat_name or "")
    store_session_response(args.session_cache_file, session_id, text, args.log)
    try:
        os.remove(args.playback_state_file)
    except OSError:
        pass


if __name__ == "__main__":
    main()
