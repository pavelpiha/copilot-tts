"""
Tests for tts_server.py — run with pytest from the project root:

    PYTHON=/path/to/venv/bin/python
    $PYTHON -m pytest server/test_tts_server.py -v

The tests exercise:
  1. Supertonic API contract (unit) — shape/type checks, no HTTP involved.
  2. FastAPI synthesize endpoint (integration) — in-process TestClient.
  3. Audio playback (smoke) — WAV bytes are playable via afplay/aplay.
"""

from __future__ import annotations

import os
import subprocess
import sys
import tempfile

import numpy as np
import pytest
from fastapi.testclient import TestClient

# ── ensure server/ is importable ─────────────────────────────────────────────
sys.path.insert(0, os.path.dirname(__file__))
from tts_server import app, _get_tts  # noqa: E402

# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

@pytest.fixture(scope="module")
def tts():
    """Shared TTS instance — model loaded once for the whole test session."""
    return _get_tts()


@pytest.fixture(scope="module")
def client():
    """In-process FastAPI test client — no real HTTP server needed."""
    with TestClient(app) as c:
        yield c


# ---------------------------------------------------------------------------
# 1. Supertonic API contract — unit tests
# ---------------------------------------------------------------------------

class TestSupersonicAPI:
    """Validate that supertonic.TTS returns what our server expects."""

    def test_synthesize_returns_two_element_tuple(self, tts):
        style = tts.get_voice_style(voice_name="M1")
        result = tts.synthesize("Hello", voice_style=style, lang="en")
        assert isinstance(result, tuple), "synthesize() must return a tuple"
        assert len(result) == 2, "tuple must have exactly 2 elements (wav, duration)"

    def test_wav_is_float32_ndarray(self, tts):
        style = tts.get_voice_style(voice_name="M1")
        wav, _ = tts.synthesize("Hello", voice_style=style, lang="en")
        assert isinstance(wav, np.ndarray), "wav must be a numpy ndarray"
        assert wav.dtype == np.float32, f"wav dtype must be float32, got {wav.dtype}"
        assert wav.ndim >= 1, "wav must have at least 1 dimension"
        assert wav.size > 0, "wav must contain audio samples"

    def test_duration_can_be_cast_to_float(self, tts):
        """
        duration is a numpy scalar / 1-D array — must be extractable as
        a plain Python float via .item().  This is the root cause of the
        'unsupported format string' / 'only 0-dimensional arrays' 500 errors.
        """
        style = tts.get_voice_style(voice_name="M1")
        _, duration = tts.synthesize("Hello world", voice_style=style, lang="en")
        dur_float = duration.item() if hasattr(duration, "item") else float(duration)
        assert isinstance(dur_float, float), "duration must be castable to float"
        assert dur_float > 0, "duration must be positive"

    def test_save_audio_writes_valid_wav(self, tts):
        style = tts.get_voice_style(voice_name="M1")
        wav, _ = tts.synthesize("Test audio output", voice_style=style, lang="en")
        with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as f:
            path = f.name
        try:
            tts.save_audio(wav, path)
            size = os.path.getsize(path)
            assert size > 44, f"WAV file too small ({size} bytes) — header only"
            # Check RIFF header
            with open(path, "rb") as fh:
                header = fh.read(4)
            assert header == b"RIFF", f"File is not a valid WAV (header: {header!r})"
        finally:
            os.unlink(path)


# ---------------------------------------------------------------------------
# 2. FastAPI endpoint — integration tests
# ---------------------------------------------------------------------------

class TestSynthesizeEndpoint:
    """Tests against the in-process FastAPI app."""

    def test_health_returns_200(self, client):
        resp = client.get("/health")
        assert resp.status_code == 200
        assert resp.json()["status"] == "ok"

    def test_synthesize_short_text_returns_wav(self, client):
        resp = client.post(
            "/synthesize",
            json={"text": "Hello, this is a test.", "voice": "M1", "lang": "en"},
        )
        assert resp.status_code == 200, f"Expected 200, got {resp.status_code}: {resp.text}"
        assert resp.headers["content-type"] == "audio/wav"
        assert len(resp.content) > 100, "Response body too small to be valid audio"
        # Check RIFF WAV header
        assert resp.content[:4] == b"RIFF", "Response is not a valid WAV file"

    def test_synthesize_returns_duration_header(self, client):
        resp = client.post(
            "/synthesize",
            json={"text": "Duration header test.", "voice": "F1", "lang": "en"},
        )
        assert resp.status_code == 200
        header = resp.headers.get("x-audio-duration")
        assert header is not None, "X-Audio-Duration header missing"
        dur = float(header)
        assert dur > 0, f"Duration must be positive, got {dur}"

    def test_synthesize_with_non_default_speed_returns_wav(self, client):
        resp = client.post(
            "/synthesize",
            json={
                "text": "Speed adjustment test.",
                "voice": "M1",
                "lang": "en",
                "speed": 1.5,
            },
        )
        assert resp.status_code == 200, (
            f"Expected 200 for speed-adjusted synthesis, got {resp.status_code}: {resp.text}"
        )
        assert resp.headers["content-type"] == "audio/wav"
        assert resp.content[:4] == b"RIFF", "Response is not a valid WAV file"

    def test_synthesize_speed_scales_reported_duration(self, client):
        normal = client.post(
            "/synthesize",
            json={"text": "Duration comparison test.", "voice": "M1", "lang": "en", "speed": 1.0},
        )
        faster = client.post(
            "/synthesize",
            json={"text": "Duration comparison test.", "voice": "M1", "lang": "en", "speed": 2.0},
        )

        assert normal.status_code == 200, f"Expected 200, got {normal.status_code}: {normal.text}"
        assert faster.status_code == 200, f"Expected 200, got {faster.status_code}: {faster.text}"

        normal_duration = float(normal.headers["x-audio-duration"])
        faster_duration = float(faster.headers["x-audio-duration"])

        assert faster_duration < normal_duration

    def test_synthesize_different_voices(self, client):
        for voice in ["M1", "M2", "F1", "F2"]:
            resp = client.post(
                "/synthesize",
                json={"text": "Voice test.", "voice": voice, "lang": "en"},
            )
            assert resp.status_code == 200, f"Voice {voice} failed: {resp.text}"
            assert resp.content[:4] == b"RIFF"

    def test_synthesize_rejects_empty_text(self, client):
        resp = client.post("/synthesize", json={"text": "   ", "voice": "M1", "lang": "en"})
        assert resp.status_code == 422, "Empty text must be rejected with 422"

    def test_synthesize_rejects_unknown_voice(self, client):
        resp = client.post("/synthesize", json={"text": "Hello", "voice": "Z9", "lang": "en"})
        assert resp.status_code == 422

    def test_synthesize_rejects_unknown_lang(self, client):
        resp = client.post("/synthesize", json={"text": "Hello", "voice": "M1", "lang": "xx"})
        assert resp.status_code == 422

    def test_synthesize_rejects_text_over_4000_chars(self, client):
        resp = client.post(
            "/synthesize",
            json={"text": "a" * 4001, "voice": "M1", "lang": "en"},
        )
        assert resp.status_code == 422


# ---------------------------------------------------------------------------
# 3. Audio playback smoke test — reads a sentence aloud
# ---------------------------------------------------------------------------

class TestAudioPlayback:
    """
    Smoke test: synthesize a sentence and play it through the system speaker.
    Skipped in CI (no audio device) but runs locally.
    """

    @pytest.mark.skipif(
        os.environ.get("CI") == "true",
        reason="No audio output in CI",
    )
    def test_text_is_read_aloud(self, client):
        """
        End-to-end: synthesize → save WAV → play via afplay (macOS) or aplay (Linux).
        The test passes only if the playback process exits 0.
        """
        resp = client.post(
            "/synthesize",
            json={"text": "Copilot TTS is working correctly.", "voice": "M1", "lang": "en"},
        )
        assert resp.status_code == 200, f"Synthesis failed: {resp.text}"
        assert resp.content[:4] == b"RIFF", "Not a valid WAV"

        with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as f:
            f.write(resp.content)
            wav_path = f.name

        try:
            if sys.platform == "darwin":
                cmd = ["afplay", wav_path]
            elif sys.platform.startswith("linux"):
                cmd = ["aplay", wav_path]
            else:
                pytest.skip("Playback not supported on this platform in tests")

            result = subprocess.run(cmd, capture_output=True, timeout=30)
            assert result.returncode == 0, (
                f"Playback command failed (exit {result.returncode}):\n"
                f"  stdout: {result.stdout.decode()}\n"
                f"  stderr: {result.stderr.decode()}"
            )
        finally:
            os.unlink(wav_path)
