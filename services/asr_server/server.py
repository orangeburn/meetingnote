from __future__ import annotations
 
import os
import math
import queue
import subprocess
import sys
import tempfile
import threading
import uuid
import faulthandler
from datetime import datetime
from pathlib import Path
from typing import Any
 
if sys.platform == "win32":
    # Fix for WinError 126 when torch is installed in Roaming profile
    user_torch_lib = os.path.expandvars(r"%APPDATA%\Python\Python310\site-packages\torch\lib")
    if os.path.exists(user_torch_lib):
        try:
            os.add_dll_directory(user_torch_lib)
        except Exception:
            pass
    # Avoid Intel OpenMP conflict errors
    os.environ["KMP_DUPLICATE_LIB_OK"] = "TRUE"

faulthandler.enable()

from fastapi import FastAPI, File, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
import uvicorn

FUNASR_IMPORT_ERROR = ""
try:
    from funasr import AutoModel
except Exception as e:
    AutoModel = None
    FUNASR_IMPORT_ERROR = str(e)

MODELSCOPE_IMPORT_ERROR = ""
try:
    from modelscope.hub.snapshot_download import snapshot_download
except Exception as e:
    snapshot_download = None
    MODELSCOPE_IMPORT_ERROR = str(e)

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
FUN_ASR_REPO_DIR = Path(__file__).resolve().parents[2] / "scratch" / "Fun-ASR"
MERGE_GAP_MS = 900
MAX_SEGMENT_CHARS = 36
MAX_SINGLE_PASS_SECONDS = 60
CHUNK_SECONDS = 60
CREATE_NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0)


class TranscriptionJobStore:
    def __init__(self) -> None:
        self._jobs: dict[str, dict[str, Any]] = {}
        self._lock = threading.Lock()

    def create_job(self, filename: str) -> str:
        job_id = uuid.uuid4().hex
        with self._lock:
            self._jobs[job_id] = {
                "job_id": job_id,
                "filename": filename,
                "status": "queued",
                "progress": 0,
                "message": "等待开始",
                "segments": [],
                "markdown": "",
                "error": "",
                "created_at": datetime.now().isoformat(),
            }
        return job_id

    def update_job(self, job_id: str, **fields: Any) -> None:
        with self._lock:
            job = self._jobs.get(job_id)
            if not job:
                return
            job.update(fields)

    def get_job(self, job_id: str) -> dict[str, Any] | None:
        with self._lock:
            job = self._jobs.get(job_id)
            if job is None:
                return None
            return dict(job)

    def get_queue_position(self, job_id: str) -> int | None:
        with self._lock:
            job = self._jobs.get(job_id)
            if job is None:
                return None
            return job.get("queue_position")


class AsrEngine:
    def __init__(self) -> None:
        self.model = None
        self.model_kwargs: dict[str, Any] = {}
        self.ready = False
        self.model_path = ""
        self.last_error = ""
        self.is_downloading = False
        self.model_complete = False
        self._init_model(auto_download=False)

    def check_model_complete(self, log_missing: bool = False) -> bool:
        if not MODEL_DIR.exists():
            if log_missing:
                print(f"[INFO] Model directory not found: {MODEL_DIR}")
            return False
        # Fun-ASR-Nano-2512 package uses torch weights (model.pt) rather than model.onnx/am.mvn.
        required = ["config.yaml", "configuration.json", "model.pt"]
        missing = [f for f in required if not (MODEL_DIR / f).exists()]
        if missing:
            if log_missing:
                print(f"[INFO] Missing required model files: {missing}")
            return False
        return True

    def _download_model_if_needed(self) -> None:
        if self.check_model_complete(log_missing=True):
            self.model_path = str(MODEL_DIR)
            return
        if os.environ.get("MEETINGNOTE_DISABLE_AUTO_DOWNLOAD", "0") == "1":
            self.last_error = "auto download disabled by MEETINGNOTE_DISABLE_AUTO_DOWNLOAD=1"
            return
        if snapshot_download is None:
            self.last_error = f"modelscope snapshot_download unavailable: {MODELSCOPE_IMPORT_ERROR}"
            return
        MODEL_DIR.parent.mkdir(parents=True, exist_ok=True)
        try:
            # Newer modelscope versions support local_dir_use_symlinks.
            local_dir = snapshot_download(
                model_id=MODEL_NAME,
                cache_dir=str(MODEL_DIR.parent),
                local_dir=str(MODEL_DIR),
                local_dir_use_symlinks=False,
            )
        except TypeError as exc:
            if "local_dir_use_symlinks" not in str(exc):
                raise
            # Backward compatibility for older modelscope versions.
            local_dir = snapshot_download(
                model_id=MODEL_NAME,
                cache_dir=str(MODEL_DIR.parent),
                local_dir=str(MODEL_DIR),
            )
        self.model_path = str(local_dir)

    def _init_model(self, force_download: bool = False, auto_download: bool = True) -> None:
        if AutoModel is None:
            self.last_error = f"funasr AutoModel unavailable: {FUNASR_IMPORT_ERROR}"
            return
        
        self.model_complete = self.check_model_complete(log_missing=True)
        print(f"[INFO] Initial model check: complete={self.model_complete}")
        
        try:
            self.last_error = ""
            if force_download or (auto_download and not self.model_complete):
                print(f"[INFO] Starting model download/verification (force={force_download})...")
                self._download_model_if_needed()
                self.model_complete = self.check_model_complete(log_missing=True)
                print(f"[INFO] Post-download model check: complete={self.model_complete}")
                
            if self.model_complete:
                print(f"[INFO] Model files ready. Loading Fun-ASR official repo model...")
                if not FUN_ASR_REPO_DIR.exists():
                    self.ready = False
                    self.model = None
                    self.last_error = (
                        f"Missing Fun-ASR repo at {FUN_ASR_REPO_DIR}. "
                        "Official model implementation is required for Fun-ASR-Nano-2512."
                    )
                    print(f"[WARN] {self.last_error}")
                    return
                repo_path = str(FUN_ASR_REPO_DIR)
                if repo_path not in sys.path:
                    sys.path.insert(0, repo_path)
                from model import FunASRNano

                self.model, self.model_kwargs = FunASRNano.from_pretrained(
                    model=str(MODEL_DIR),
                    device="cpu",
                )
                self.model.eval()
                self.ready = True
                self.model_path = str(MODEL_DIR)
                print(f"[INFO] ASR Engine is ready with model: {MODEL_DIR}")
            else:
                self.ready = False
                self.model = None
                # "model not complete" is a normal pre-download state, not a hard error.
                # Keep last_error empty here so frontend can auto-trigger /api/model/download.
                if self.last_error:
                    print(f"[WARN] ASR Engine not ready: {self.last_error}")
                else:
                    print("[INFO] ASR Engine waiting for model download (model files incomplete).")
        except Exception as exc:
            self.ready = False
            self.model = None
            # Keep file completeness state instead of forcing re-download loop.
            self.model_complete = self.check_model_complete(log_missing=False)
            self.last_error = str(exc)
            print(f"[ERROR] model init failed: {exc}")

    def start_download_async(self):
        if self.is_downloading:
            print("[INFO] Download is already in progress.")
            return
        if self.model_complete:
            print("[INFO] Model already complete, skipping download.")
            return
        self.is_downloading = True
        print("[INFO] Spawning background thread for model download...")
        
        def _task():
            try:
                # Do not force download when files are already complete.
                self._init_model(force_download=False)
            finally:
                self.is_downloading = False
                print("[INFO] Background download thread finished.")
                
        t = threading.Thread(target=_task, daemon=True)
        t.start()

    def _mock_segments(self) -> list[dict[str, Any]]:
        return [
            {"speaker": "Speaker 1", "start_ms": 0, "end_ms": 3200, "text": "我们开始今天的项目周会。"},
            {"speaker": "Speaker 2", "start_ms": 3500, "end_ms": 7600, "text": "先同步迭代计划和风险项。"},
        ]

    def _run_inference(self, audio_path: Path) -> list[dict[str, Any]]:
        result, _meta = self.model.inference(
            data_in=[str(audio_path)],
            hotwords=["会议", "讨论", "决议"],
            language="中文",
            itn=True,
            **self.model_kwargs,
        )
        return self._normalize_result(result)

    def _get_audio_duration_seconds(self, audio_path: Path) -> float:
        cmd = [
            "ffprobe",
            "-v",
            "error",
            "-show_entries",
            "format=duration",
            "-of",
            "default=noprint_wrappers=1:nokey=1",
            str(audio_path),
        ]
        completed = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            check=True,
            creationflags=CREATE_NO_WINDOW,
        )
        return max(0.0, float((completed.stdout or "0").strip() or "0"))

    def _split_audio_chunks(self, audio_path: Path, chunk_seconds: int) -> list[tuple[Path, int]]:
        duration_seconds = self._get_audio_duration_seconds(audio_path)
        print(f"[INFO] audio duration: {duration_seconds:.2f}s for {audio_path}")
        if duration_seconds <= 0:
            return [(audio_path, 0)]

        chunk_dir = Path(tempfile.mkdtemp(prefix="meetingnote_asr_chunks_"))
        chunks: list[tuple[Path, int]] = []
        if duration_seconds <= MAX_SINGLE_PASS_SECONDS:
            total_chunks = 1
        else:
            total_chunks = max(1, math.ceil(duration_seconds / chunk_seconds))
        print(f"[INFO] preparing {total_chunks} chunk(s), chunk_seconds={chunk_seconds}")

        for index in range(total_chunks):
            start_seconds = index * chunk_seconds
            chunk_path = chunk_dir / f"chunk_{index:03d}.wav"
            cmd = [
                "ffmpeg",
                "-y",
                "-hide_banner",
                "-loglevel",
                "error",
                "-ss",
                str(start_seconds),
                "-i",
                str(audio_path),
            ]
            if total_chunks > 1:
                cmd.extend(
                    [
                        "-t",
                        str(chunk_seconds),
                    ]
                )
            cmd.extend(
                [
                    "-ar",
                    "16000",
                    "-ac",
                    "1",
                    str(chunk_path),
                ]
            )
            subprocess.run(
                cmd,
                capture_output=True,
                text=True,
                check=True,
                creationflags=CREATE_NO_WINDOW,
            )
            if chunk_path.exists() and chunk_path.stat().st_size > 0:
                print(f"[INFO] prepared chunk {index + 1}/{total_chunks}: {chunk_path}")
                chunks.append((chunk_path, start_seconds * 1000))

        return chunks or [(audio_path, 0)]

    def _cleanup_chunk_files(self, chunks: list[tuple[Path, int]]) -> None:
        parent_dirs: set[Path] = set()
        for chunk_path, _offset_ms in chunks:
            if chunk_path.exists():
                try:
                    chunk_path.unlink()
                except Exception:
                    pass
            parent_dirs.add(chunk_path.parent)
        for directory in parent_dirs:
            if directory == MODEL_DIR or directory == MODEL_DIR.parent:
                continue
            if directory.exists() and directory.name.startswith("meetingnote_asr_chunks_"):
                try:
                    directory.rmdir()
                except Exception:
                    pass

    def _offset_segments(
        self,
        segments: list[dict[str, Any]],
        offset_ms: int,
    ) -> list[dict[str, Any]]:
        shifted: list[dict[str, Any]] = []
        for seg in segments:
            next_seg = dict(seg)
            next_seg["start_ms"] = max(0, int(next_seg.get("start_ms", 0)) + offset_ms)
            next_seg["end_ms"] = max(next_seg["start_ms"], int(next_seg.get("end_ms", 0)) + offset_ms)
            shifted.append(next_seg)
        return shifted

    def transcribe_file(
        self,
        audio_path: Path,
        progress_callback: Any | None = None,
    ) -> list[dict[str, Any]]:
        if not self.ready or self.model is None:
            return []

        try:
            self.last_error = ""
            chunks = self._split_audio_chunks(audio_path, CHUNK_SECONDS)
            total_chunks = len(chunks)
            merged_segments: list[dict[str, Any]] = []

            for index, (chunk_path, offset_ms) in enumerate(chunks, start=1):
                print(f"[INFO] starting inference for chunk {index}/{total_chunks}: {chunk_path}")
                if progress_callback is not None:
                    if total_chunks == 1:
                        progress_callback(35, "正在执行音频转写")
                    else:
                        progress = 20 + int(index / total_chunks * 60)
                        progress_callback(progress, f"正在转写第 {index}/{total_chunks} 段音频")
                chunk_segments = self._run_inference(chunk_path)
                print(f"[INFO] finished inference for chunk {index}/{total_chunks}, segments={len(chunk_segments)}")
                merged_segments.extend(self._offset_segments(chunk_segments, offset_ms))
                partial_segments = merge_segments(merged_segments)
                if progress_callback is not None and partial_segments:
                    if total_chunks == 1:
                        partial_message = f"已输出 {len(partial_segments)} 段内容"
                    else:
                        partial_message = f"第 {index}/{total_chunks} 段完成，已输出 {len(partial_segments)} 段内容"
                    progress_callback(
                        max(35, 20 + int(index / total_chunks * 60)),
                        partial_message,
                        partial_segments,
                    )

            segments = merge_segments(merged_segments)
            if progress_callback is not None:
                progress_callback(92, "正在整理说话人与时间戳")
            return segments
        except Exception as exc:
            self.last_error = str(exc)
            print(f"[WARN] inference failed: {exc}")
            return []
        finally:
            try:
                if "chunks" in locals():
                    self._cleanup_chunk_files(chunks)
            except Exception:
                pass

    def _normalize_result(self, result: Any) -> list[dict[str, Any]]:
        segments: list[dict[str, Any]] = []
        if not isinstance(result, list) or not result:
            return self._mock_segments()
        first = result[0]
        if not isinstance(first, dict):
            return self._mock_segments()

        sentence_info = first.get("sentence_info") or first.get("timestamps") or []
        if sentence_info:
            for idx, item in enumerate(sentence_info):
                start = int(float(item.get("start", item.get("start_time", 0))) * (1000 if "start_time" in item else 1))
                end_raw = item.get("end", item.get("end_time", start + 1000))
                end = int(float(end_raw) * (1000 if "end_time" in item else 1))
                text = str(item.get("text", item.get("token", ""))).strip()
                if not text:
                    continue
                spk = item.get("spk")
                speaker = f"Speaker {spk}" if spk is not None else "Speaker 1"
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
        return merge_segments(segments)


engine = AsrEngine()
job_store = TranscriptionJobStore()
job_queue: queue.Queue[tuple[str, Path]] = queue.Queue()


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


def is_sentence_boundary(text: str) -> bool:
    return text.endswith(("。", "！", "？", ".", "!", "?", ";", "；"))


def merge_segments(segments: list[dict[str, Any]]) -> list[dict[str, Any]]:
    if not segments:
        return []

    merged: list[dict[str, Any]] = []
    current = dict(segments[0])

    for seg in segments[1:]:
        next_seg = dict(seg)
        current_text = str(current.get("text", "")).strip()
        next_text = str(next_seg.get("text", "")).strip()
        gap_ms = max(0, int(next_seg["start_ms"]) - int(current["end_ms"]))
        same_speaker = current.get("speaker") == next_seg.get("speaker")
        combined_text = f"{current_text}{next_text}"

        should_merge = (
            same_speaker
            and gap_ms <= MERGE_GAP_MS
            and not is_sentence_boundary(current_text)
            and (
                len(current_text) <= 8
                or len(next_text) <= 8
                or len(combined_text) <= MAX_SEGMENT_CHARS
            )
        )

        if should_merge:
            current["text"] = combined_text
            current["end_ms"] = max(int(current["end_ms"]), int(next_seg["end_ms"]))
            continue

        if current_text:
            current["text"] = current_text
            merged.append(current)
        current = next_seg

    current["text"] = str(current.get("text", "")).strip()
    if current["text"]:
        merged.append(current)
    return merged


@app.get("/health")
def health() -> JSONResponse:
    return JSONResponse(
        {
            "ok": True,
            "model": MODEL_NAME,
            "ready": engine.ready,
            "model_path": engine.model_path,
            "model_exists": MODEL_DIR.exists(),
            "model_complete": engine.model_complete,
            "is_downloading": engine.is_downloading,
            "last_error": engine.last_error,
        }
    )


@app.post("/api/model/download")
def download_model() -> JSONResponse:
    engine.start_download_async()
    return JSONResponse(
        {
            "ok": True,
            "is_downloading": engine.is_downloading,
        }
    )

def get_dir_size(path: Path) -> int:
    total = 0
    if not path.exists():
        return total
    for f in path.rglob('*'):
        if f.is_file():
            total += f.stat().st_size
    return total

@app.get("/api/model/download_status")
def download_status() -> JSONResponse:
    # return the size of the temporary download cache
    cache_dir = MODEL_DIR.parent
    downloaded_bytes = get_dir_size(cache_dir)
    return JSONResponse({
        "is_downloading": engine.is_downloading,
        "model_complete": engine.check_model_complete(log_missing=False),
        "downloaded_bytes": downloaded_bytes,
        "last_error": engine.last_error
    })


@app.post("/api/transcribe")
async def transcribe(file: UploadFile = File(...)) -> JSONResponse:
    suffix = Path(file.filename or "upload.wav").suffix or ".wav"
    with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as tmp:
        tmp_path = Path(tmp.name)
        content = await file.read()
        tmp.write(content)

    segments = engine.transcribe_file(tmp_path)
    if not segments and engine.last_error:
        return JSONResponse({"segments": [], "markdown": "", "error": engine.last_error}, status_code=503)
    markdown = render_markdown(segments)
    return JSONResponse({"segments": segments, "markdown": markdown})


def _run_transcription_job(job_id: str, tmp_path: Path) -> None:
    def report(progress: int, message: str, segments_snapshot: list[dict[str, Any]] | None = None) -> None:
        fields: dict[str, Any] = {
            "status": "processing",
            "progress": max(0, min(100, progress)),
            "message": message,
        }
        if segments_snapshot is not None:
            fields["segments"] = segments_snapshot
            fields["markdown"] = render_markdown(segments_snapshot)
        job_store.update_job(
            job_id,
            **fields,
        )

    try:
        report(5, "正在校验音频文件")
        report(15, "正在加载整段音频")
        segments = engine.transcribe_file(tmp_path, progress_callback=report)
        if not segments and engine.last_error:
            job_store.update_job(
                job_id,
                status="failed",
                progress=100,
                message="转写失败",
                error=engine.last_error,
            )
            return

        markdown = render_markdown(segments)
        job_store.update_job(
            job_id,
            status="completed",
            progress=100,
            message="转写完成",
            segments=segments,
            markdown=markdown,
            error="",
        )
    except Exception as exc:
        job_store.update_job(
            job_id,
            status="failed",
            progress=100,
            message="转写失败",
            error=str(exc),
        )
    finally:
        try:
            tmp_path.unlink(missing_ok=True)
        except Exception:
            pass


def _refresh_queue_positions() -> None:
    queued_items = list(job_queue.queue)
    for index, (queued_job_id, _tmp_path) in enumerate(queued_items, start=1):
        job_store.update_job(
            queued_job_id,
            status="queued",
            progress=0,
            queue_position=index,
            message=f"排队中，前面还有 {index - 1} 个任务",
        )


def _transcription_worker_loop() -> None:
    while True:
        job_id, tmp_path = job_queue.get()
        try:
            job_store.update_job(
                job_id,
                status="processing",
                progress=1,
                queue_position=0,
                message="任务已开始",
            )
            _refresh_queue_positions()
            _run_transcription_job(job_id, tmp_path)
        except Exception as exc:
            job_store.update_job(
                job_id,
                status="failed",
                progress=100,
                queue_position=0,
                message="转写失败",
                error=str(exc),
            )
            try:
                tmp_path.unlink(missing_ok=True)
            except Exception:
                pass
        finally:
            job_queue.task_done()
            _refresh_queue_positions()


worker_thread = threading.Thread(target=_transcription_worker_loop, daemon=True, name="transcription-worker")
worker_thread.start()


@app.post("/api/transcribe/jobs")
async def create_transcription_job(file: UploadFile = File(...)) -> JSONResponse:
    suffix = Path(file.filename or "upload.wav").suffix or ".wav"
    with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as tmp:
        tmp_path = Path(tmp.name)
        content = await file.read()
        tmp.write(content)

    job_id = job_store.create_job(file.filename or tmp_path.name)
    job_queue.put((job_id, tmp_path))
    queue_position = job_queue.qsize()
    job_store.update_job(
        job_id,
        status="queued",
        progress=0,
        queue_position=queue_position,
        message=f"已进入队列，前面还有 {queue_position - 1} 个任务",
    )
    _refresh_queue_positions()
    return JSONResponse({"job_id": job_id})


@app.get("/api/transcribe/jobs/{job_id}")
def get_transcription_job(job_id: str) -> JSONResponse:
    job = job_store.get_job(job_id)
    if job is None:
        return JSONResponse({"error": "job not found"}, status_code=404)
    return JSONResponse(job)


if __name__ == "__main__":
    uvicorn.run(app, host="127.0.0.1", port=8765)
