from __future__ import annotations

import asyncio
import json
import os
import tempfile
import wave
from datetime import datetime
from pathlib import Path
from typing import Any

from fastapi import FastAPI, File, UploadFile, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
import uvicorn

try:
    from funasr import AutoModel
except Exception:
    AutoModel = None

try:
    from modelscope.hub.snapshot_download import snapshot_download
except Exception:
    snapshot_download = None

app = FastAPI(title="MeetingNote ASR Service")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

MODEL_NAME = "FunAudioLLM/Fun-ASR-Nano-2512"
MODEL_DIR = Path(__file__).resolve().parent / "models" / "Fun-ASR-Nano-2512"


class AsrEngine:
    def __init__(self) -> None:
        self.model = None
        self.ready = False
        self.model_path = ""
        self.last_error = ""
        self._init_model()

    def _download_model_if_needed(self) -> None:
        if MODEL_DIR.exists():
            self.model_path = str(MODEL_DIR)
            return
        if os.environ.get("MEETINGNOTE_DISABLE_AUTO_DOWNLOAD", "0") == "1":
            self.last_error = "auto download disabled by MEETINGNOTE_DISABLE_AUTO_DOWNLOAD=1"
            return
        if snapshot_download is None:
            self.last_error = "modelscope snapshot_download unavailable; install modelscope"
            return
        MODEL_DIR.parent.mkdir(parents=True, exist_ok=True)
        local_dir = snapshot_download(
            model_id=MODEL_NAME,
            cache_dir=str(MODEL_DIR.parent),
            local_dir=str(MODEL_DIR),
            local_dir_use_symlinks=False,
        )
        self.model_path = str(local_dir)

    def _init_model(self, force_download: bool = False) -> None:
        if AutoModel is None:
            self.last_error = "funasr AutoModel unavailable; install funasr"
            return
        try:
            self.last_error = ""
            if force_download or not MODEL_DIR.exists():
                self._download_model_if_needed()
            if MODEL_DIR.exists():
                self.model_path = str(MODEL_DIR)
            model_ref = self.model_path if self.model_path else MODEL_NAME
            self.model = AutoModel(
                model=model_ref,
                model_hub="ms",
                trust_remote_code=True,
            )
            self.ready = True
        except Exception as exc:
            self.ready = False
            self.model = None
            self.last_error = str(exc)
            print(f"[WARN] model init failed: {exc}")

    def _mock_segments(self) -> list[dict[str, Any]]:
        return [
            {"speaker": "Speaker 1", "start_ms": 0, "end_ms": 3200, "text": "我们开始今天的项目周会。"},
            {"speaker": "Speaker 2", "start_ms": 3500, "end_ms": 7600, "text": "先同步迭代计划和风险项。"},
        ]

    def transcribe_file(self, audio_path: Path) -> list[dict[str, Any]]:
        if not self.ready or self.model is None:
            return self._mock_segments()

        try:
            # Note: diarization/timestamp parameters may vary by FunASR version.
            result = self.model.generate(
                input=str(audio_path),
                batch_size_s=60,
                hotword="会议 讨论 决议",
            )
            return self._normalize_result(result)
        except Exception as exc:
            print(f"[WARN] inference failed, fallback mock: {exc}")
            return self._mock_segments()

    def _normalize_result(self, result: Any) -> list[dict[str, Any]]:
        segments: list[dict[str, Any]] = []
        if not isinstance(result, list) or not result:
            return self._mock_segments()
        first = result[0]
        if not isinstance(first, dict):
            return self._mock_segments()

        sentence_info = first.get("sentence_info") or []
        if sentence_info:
            for idx, item in enumerate(sentence_info):
                start = int(item.get("start", 0))
                end = int(item.get("end", start + 1000))
                text = str(item.get("text", "")).strip()
                spk = item.get("spk")
                speaker = f"Speaker {spk}" if spk is not None else f"Speaker {(idx % 2) + 1}"
                segments.append(
                    {
                        "speaker": speaker,
                        "start_ms": max(0, start),
                        "end_ms": max(start, end),
                        "text": text,
                    }
                )

        if not segments:
            text = str(first.get("text", "")).strip() or "(empty)"
            segments = [{"speaker": "Speaker 1", "start_ms": 0, "end_ms": 5000, "text": text}]
        return segments


engine = AsrEngine()


def render_markdown(segments: list[dict[str, Any]]) -> str:
    now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    lines = ["# 会议转写", "", f"- 生成时间：{now}", ""]
    for seg in segments:
        start = ms_to_hhmmss(seg["start_ms"])
        end = ms_to_hhmmss(seg["end_ms"])
        lines.append(f"[{start} - {end}] [{seg['speaker']}]")
        lines.append(seg["text"])
        lines.append("")
    return "\n".join(lines)


def ms_to_hhmmss(ms: int) -> str:
    sec = ms // 1000
    hh = sec // 3600
    mm = (sec % 3600) // 60
    ss = sec % 60
    return f"{hh:02d}:{mm:02d}:{ss:02d}"


@app.get("/health")
def health() -> JSONResponse:
    return JSONResponse(
        {
            "ok": True,
            "model": MODEL_NAME,
            "ready": engine.ready,
            "model_path": engine.model_path,
            "model_exists": MODEL_DIR.exists(),
            "last_error": engine.last_error,
        }
    )


@app.post("/api/model/download")
def download_model() -> JSONResponse:
    engine._init_model(force_download=True)
    return JSONResponse(
        {
            "ok": True,
            "ready": engine.ready,
            "model_path": engine.model_path,
            "model_exists": MODEL_DIR.exists(),
            "last_error": engine.last_error,
        }
    )


@app.post("/api/transcribe")
async def transcribe(file: UploadFile = File(...)) -> JSONResponse:
    suffix = Path(file.filename or "upload.wav").suffix or ".wav"
    with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as tmp:
        tmp_path = Path(tmp.name)
        content = await file.read()
        tmp.write(content)

    segments = engine.transcribe_file(tmp_path)
    markdown = render_markdown(segments)
    return JSONResponse({"segments": segments, "markdown": markdown})


@app.websocket("/ws/stream")
async def ws_stream(websocket: WebSocket, source: str = "mic") -> None:
    await websocket.accept()
    record_file = None
    wf = None
    try:
        while True:
            raw = await websocket.receive_text()
            data = json.loads(raw)
            if data.get("type") == "start":
                if data.get("record"):
                    record_name = datetime.now().strftime(f"record_{source}_%Y%m%d_%H%M%S.wav")
                    record_file = Path.cwd() / "records"
                    record_file.mkdir(exist_ok=True)
                    wav_path = record_file / record_name
                    wf = wave.open(str(wav_path), "wb")
                    wf.setnchannels(1)
                    wf.setsampwidth(2)
                    wf.setframerate(16000)
                await websocket.send_text(json.dumps({"type": "status", "message": "started"}))

                for seg in engine._mock_segments():
                    await asyncio.sleep(0.6)
                    await websocket.send_text(json.dumps({"type": "segment", "segment": seg}, ensure_ascii=False))
                    if wf:
                        wf.writeframes(b"\x00\x00" * 16000)

            elif data.get("type") == "audio_chunk":
                # reserved: frontend can stream PCM chunks here
                if wf and "pcm16" in data:
                    pass
            elif data.get("type") == "stop":
                await websocket.send_text(json.dumps({"type": "status", "message": "stopped"}))
                break
    except WebSocketDisconnect:
        pass
    finally:
        if wf:
            wf.close()


if __name__ == "__main__":
    uvicorn.run(app, host="127.0.0.1", port=8765)
