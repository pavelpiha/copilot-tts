#!/usr/bin/env python3
"""
Local TTS server for the Copilot TTS VS Code extension.

Runs Supertonic 3 (https://huggingface.co/Supertone/supertonic-3) entirely
on-device via ONNX Runtime — no internet call is made during synthesis.

Dependencies:
    pip install supertonic fastapi uvicorn

Usage:
    python tts_server.py --port 8765
"""

from __future__ import annotations

import argparse
import os
import sys
import tempfile
import wave
from contextlib import asynccontextmanager
from typing import AsyncGenerator

import uvicorn
from fastapi import FastAPI, HTTPException
from fastapi.responses import Response
from pydantic import BaseModel, field_validator

# ---------------------------------------------------------------------------
# Lazy model loading
# ---------------------------------------------------------------------------

_tts = None  # type: ignore[assignment]


def _get_tts():
    """Return a cached TTS instance, loading it on first call."""
    global _tts
    if _tts is None:
        try:
            from supertonic import TTS  # type: ignore[import]
        except ImportError as exc:
            raise RuntimeError(
                "supertonic package not found. "
                "Install it with:  pip install supertonic"
            ) from exc
        _tts = TTS(auto_download=True)
    return _tts


# ---------------------------------------------------------------------------
# FastAPI app
# ---------------------------------------------------------------------------

@asynccontextmanager
async def _lifespan(app: FastAPI) -> AsyncGenerator[None, None]:
    """Pre-warm the TTS model so the first synthesis request is fast."""
    try:
        print("[INFO] TTS server loading Supertonic 3 model…", flush=True)
        _get_tts()
        print("[INFO] TTS server model ready.", flush=True)
    except Exception as exc:  # noqa: BLE001
        # Non-fatal — the model will be loaded on the first synthesis request.
        print(
            f"[WARN] TTS server could not pre-load model: {exc}",
            flush=True,
        )
    yield


app = FastAPI(
    title="Copilot TTS",
    description="Local on-device TTS powered by Supertonic 3",
    version="0.1.0",
    lifespan=_lifespan,
)


# ---------------------------------------------------------------------------
# Request / response schemas
# ---------------------------------------------------------------------------

KNOWN_VOICES = frozenset(["M1", "M2", "M3", "M4", "F1", "F2", "F3", "F4"])

SUPPORTED_LANGS = frozenset([
    "en", "ko", "ja", "ar", "bg", "cs", "da", "de", "el", "es",
    "et", "fi", "fr", "hi", "hr", "hu", "id", "it", "lt", "lv",
    "nl", "pl", "pt", "ro", "ru", "sk", "sl", "sv", "tr", "uk", "vi",
])


class SynthesizeRequest(BaseModel):
    text: str
    voice: str = "M1"
    lang: str = "en"
    speed: float = 1.0  # playback rate multiplier (0.25–4.0)

    @field_validator("text")
    @classmethod
    def _text_not_empty(cls, v: str) -> str:
        stripped = v.strip()
        if not stripped:
            raise ValueError("text must not be empty")
        # Hard cap to prevent abuse / excessively long requests
        if len(stripped) > 4_000:
            raise ValueError("text must not exceed 4 000 characters")
        return stripped

    @field_validator("voice")
    @classmethod
    def _voice_valid(cls, v: str) -> str:
        if v not in KNOWN_VOICES:
            raise ValueError(
                f"Unknown voice '{v}'. Known presets: {sorted(KNOWN_VOICES)}"
            )
        return v

    @field_validator("lang")
    @classmethod
    def _lang_valid(cls, v: str) -> str:
        if v not in SUPPORTED_LANGS:
            raise ValueError(
                f"Unsupported language '{v}'. Supported: {sorted(SUPPORTED_LANGS)}"
            )
        return v

    @field_validator("speed")
    @classmethod
    def _speed_valid(cls, v: float) -> float:
        if not (0.25 <= v <= 4.0):
            raise ValueError("speed must be between 0.25 and 4.0")
        return v


def _resolve_sample_rate(tts: object) -> int:
    for attr in ("sample_rate", "sampling_rate", "sr"):
        value = getattr(tts, attr, None)
        if isinstance(value, (int, float)) and value > 0:
            return int(value)
    return 24_000


def _save_audio_with_fallback(tts: object, wav: object, path: str) -> None:
    try:
        # Prefer the SDK helper when libsndfile is available.
        tts.save_audio(wav, path)  # type: ignore[attr-defined]
        return
    except Exception:
        pass

    # Fallback for environments where soundfile/libsndfile is unavailable
    # (for example some Windows ARM Python installations).
    try:
        import numpy as np
    except ImportError as exc:
        raise RuntimeError(
            "Unable to save synthesized audio: numpy is required for WAV fallback."
        ) from exc

    sample_rate = _resolve_sample_rate(tts)
    arr = np.asarray(wav, dtype=np.float32).reshape(-1)
    arr = np.clip(arr, -1.0, 1.0)
    pcm16 = (arr * 32767.0).astype(np.int16)

    with wave.open(path, "wb") as handle:
        handle.setnchannels(1)
        handle.setsampwidth(2)
        handle.setframerate(sample_rate)
        handle.writeframes(pcm16.tobytes())
        return


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------

@app.get("/health")
async def health() -> dict:
    """Health check — returns 200 when the server is ready."""
    return {"status": "ok", "model": "supertonic-3"}


@app.get("/voices")
async def list_voices() -> dict:
    """Return the list of available preset voice names."""
    return {"voices": sorted(KNOWN_VOICES)}


@app.post("/synthesize")
async def synthesize(req: SynthesizeRequest) -> Response:
    """
    Synthesize *req.text* and return raw WAV audio (audio/wav).

    The WAV file is written to a temporary path and streamed back so the
    extension can play it without writing to disk itself.
    """
    try:
        tts = _get_tts()
        style = tts.get_voice_style(voice_name=req.voice)
        wav, duration = tts.synthesize(req.text, voice_style=style, lang=req.lang)
        # duration is a numpy array with shape (1,) — .item() extracts a plain Python float
        duration_s = duration.item() if hasattr(duration, "item") else float(duration)

        # Persist to a temp file so save_audio can write the WAV header.
        tmp_fd, tmp_path = tempfile.mkstemp(suffix=".wav")
        os.close(tmp_fd)
        try:
            _save_audio_with_fallback(tts, wav, tmp_path)
            with open(tmp_path, "rb") as fh:
                wav_bytes = fh.read()
        finally:
            for p in (tmp_path,):
                try:
                    os.unlink(p)
                except OSError:
                    pass

        adjusted_duration = duration_s / req.speed

        return Response(
            content=wav_bytes,
            media_type="audio/wav",
            headers={"X-Audio-Duration": f"{adjusted_duration:.3f}"},
        )

    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except RuntimeError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=500, detail=str(exc)) from exc


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

def main() -> None:
    parser = argparse.ArgumentParser(description="Copilot TTS local server")
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument(
        "--host",
        type=str,
        default="127.0.0.1",
        help="Bind only to localhost (default) for security.",
    )
    args = parser.parse_args()

    # Confirm we are binding only to localhost — reject 0.0.0.0 for safety.
    if args.host not in ("127.0.0.1", "localhost", "::1"):
        print(
            "ERROR: For security reasons this server must bind to localhost only.",
            file=sys.stderr,
        )
        sys.exit(1)

    uvicorn.run(app, host=args.host, port=args.port, log_level="info")


if __name__ == "__main__":
    main()
