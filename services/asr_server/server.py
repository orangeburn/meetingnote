from __future__ import annotations
 
import os
import math
import queue
import sqlite3
import subprocess
import sys
import tempfile
import threading
import time
import uuid
import faulthandler
import shutil
import wave
import shlex
from datetime import datetime
from pathlib import Path
from typing import Any
import json

# ---------------------------------------------------------------------------
# Windows: monkey-patch subprocess.Popen BEFORE any third-party imports.
# This ensures that ALL subprocess calls (including those made internally by
# funasr, torchaudio, torch, etc.) automatically receive CREATE_NO_WINDOW
# and a hidden STARTUPINFO, preventing console-window flashes on Windows.
# ---------------------------------------------------------------------------
CREATE_NO_WINDOW: int = getattr(subprocess, "CREATE_NO_WINDOW", 0x08000000)
STARTUPINFO: subprocess.STARTUPINFO | None = None

if sys.platform == "win32":
    STARTUPINFO = subprocess.STARTUPINFO()
    STARTUPINFO.dwFlags |= subprocess.STARTF_USESHOWWINDOW
    STARTUPINFO.wShowWindow = subprocess.SW_HIDE

    _original_popen_init = subprocess.Popen.__init__

    def _patched_popen_init(self, *args, **kwargs):  # type: ignore[no-untyped-def]
        """Wrapper that injects hidden-window flags into every Popen call."""
        kwargs.setdefault("creationflags", 0)
        kwargs["creationflags"] |= CREATE_NO_WINDOW
        if kwargs.get("startupinfo") is None:
            kwargs["startupinfo"] = STARTUPINFO
        kwargs.setdefault("stdin", subprocess.DEVNULL)
        _original_popen_init(self, *args, **kwargs)

    subprocess.Popen.__init__ = _patched_popen_init  # type: ignore[assignment]

 
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
from pydantic import BaseModel
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

def get_data_dir() -> Path:
    env_override = os.environ.get("MEETINGNOTE_DATA_DIR")
    if env_override:
        return Path(env_override).expanduser().resolve()
    if sys.platform == "win32":
        local_appdata = os.environ.get("LOCALAPPDATA") or str(Path.home() / "AppData" / "Local")
        return Path(local_appdata) / "MeetingNote"
    return Path.home() / ".local" / "share" / "meetingnote"


DATA_DIR = get_data_dir()
DATA_DIR.mkdir(parents=True, exist_ok=True)
UPLOAD_DIR = DATA_DIR / "uploads"
UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
DB_PATH = DATA_DIR / "meetingnote.db"
PROCESS_LOG_PATH = DATA_DIR / "process-spawn.log"


def hidden_subprocess_kwargs(**kwargs: Any) -> dict[str, Any]:
    if sys.platform != "win32":
        return kwargs
    return {
        **kwargs,
        "creationflags": kwargs.get("creationflags", 0) | CREATE_NO_WINDOW,
        "startupinfo": STARTUPINFO,
        "stdin": kwargs.get("stdin", subprocess.DEVNULL),
    }


def _format_subprocess_cmd(cmd: Any) -> str:
    if isinstance(cmd, (list, tuple)):
        return shlex.join(str(part) for part in cmd)
    return str(cmd)


def log_process_spawn(source: str, cmd: Any) -> None:
    try:
        timestamp = datetime.now().isoformat()
        PROCESS_LOG_PATH.parent.mkdir(parents=True, exist_ok=True)
        with PROCESS_LOG_PATH.open("a", encoding="utf-8") as log_file:
            log_file.write(f"{timestamp} [{source}] {_format_subprocess_cmd(cmd)}\n")
    except Exception:
        pass


def run_logged_subprocess(cmd: Any, source: str, **kwargs: Any) -> subprocess.CompletedProcess[str]:
    log_process_spawn(source, cmd)
    return subprocess.run(cmd, **hidden_subprocess_kwargs(**kwargs))


def resolve_binary(binary_name: str) -> str:
    """
    Resolve to a real executable on Windows to avoid launching cmd/bat wrappers,
    which can cause transient console flashes.
    """
    env_override = os.environ.get(f"MEETINGNOTE_{binary_name.upper()}_BIN")
    if env_override and Path(env_override).exists():
        return env_override

    if sys.platform != "win32":
        return shutil.which(binary_name) or binary_name

    # Prefer project-vendored binaries to avoid Chocolatey/Scoop shims that can flash a console window.
    vendor_dir = Path(__file__).resolve().parent / "vendor" / "ffmpeg" / "win32"
    vendored = vendor_dir / f"{binary_name}.exe"
    if vendored.exists():
        return str(vendored)

    if binary_name in {"ffmpeg", "ffprobe"}:
        raise FileNotFoundError(f"Missing vendored {binary_name}.exe under {vendor_dir}")

    preferred = shutil.which(f"{binary_name}.exe") or shutil.which(binary_name)
    if preferred and preferred.lower().endswith(".exe"):
        return preferred

    try:
        completed = run_logged_subprocess(
            ["where", binary_name],
            source=f"resolve_binary:{binary_name}",
            capture_output=True,
            text=True,
            check=True,
        )
        for line in (completed.stdout or "").splitlines():
            candidate = line.strip()
            if candidate.lower().endswith(".exe"):
                return candidate
    except Exception:
        pass

    return preferred or binary_name


FFMPEG_BIN = resolve_binary("ffmpeg")


class TranscriptionJobStore:
    def __init__(self) -> None:
        self._jobs: dict[str, dict[str, Any]] = {}
        self._lock = threading.Lock()
        self._db_path = DB_PATH
        self._ensure_db()
        self._load_jobs()

    def _connect(self) -> sqlite3.Connection:
        conn = sqlite3.connect(self._db_path, check_same_thread=False)
        conn.row_factory = sqlite3.Row
        return conn

    def _ensure_db(self) -> None:
        with self._connect() as conn:
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS transcription_jobs (
                    job_id TEXT PRIMARY KEY,
                    filename TEXT NOT NULL,
                    audio_path TEXT NOT NULL DEFAULT '',
                    status TEXT NOT NULL,
                    progress INTEGER NOT NULL DEFAULT 0,
                    message TEXT NOT NULL DEFAULT '',
                    segments_json TEXT NOT NULL DEFAULT '[]',
                    markdown TEXT NOT NULL DEFAULT '',
                    error TEXT NOT NULL DEFAULT '',
                    queue_position INTEGER,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                )
                """
            )
            columns = {row[1] for row in conn.execute("PRAGMA table_info(transcription_jobs)").fetchall()}
            if "audio_path" not in columns:
                conn.execute("ALTER TABLE transcription_jobs ADD COLUMN audio_path TEXT NOT NULL DEFAULT ''")
            conn.commit()

    def _row_to_job(self, row: sqlite3.Row) -> dict[str, Any]:
        return {
            "job_id": row["job_id"],
            "filename": row["filename"],
            "audio_path": row["audio_path"] if "audio_path" in row.keys() else "",
            "status": row["status"],
            "progress": row["progress"],
            "message": row["message"],
            "segments": json.loads(row["segments_json"] or "[]"),
            "markdown": row["markdown"] or "",
            "error": row["error"] or "",
            "queue_position": row["queue_position"],
            "created_at": row["created_at"],
            "updated_at": row["updated_at"],
        }

    def _persist_job(self, job: dict[str, Any]) -> None:
        with self._connect() as conn:
            conn.execute(
                """
                INSERT INTO transcription_jobs (
                    job_id, filename, audio_path, status, progress, message, segments_json, markdown,
                    error, queue_position, created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(job_id) DO UPDATE SET
                    filename=excluded.filename,
                    audio_path=excluded.audio_path,
                    status=excluded.status,
                    progress=excluded.progress,
                    message=excluded.message,
                    segments_json=excluded.segments_json,
                    markdown=excluded.markdown,
                    error=excluded.error,
                    queue_position=excluded.queue_position,
                    created_at=excluded.created_at,
                    updated_at=excluded.updated_at
                """,
                (
                    job["job_id"],
                    job["filename"],
                    job.get("audio_path", ""),
                    job["status"],
                    job["progress"],
                    job["message"],
                    json.dumps(job.get("segments", []), ensure_ascii=False),
                    job.get("markdown", ""),
                    job.get("error", ""),
                    job.get("queue_position"),
                    job["created_at"],
                    job["updated_at"],
                ),
            )
            conn.commit()

    def _load_jobs(self) -> None:
        with self._connect() as conn:
            rows = conn.execute(
                "SELECT * FROM transcription_jobs ORDER BY datetime(updated_at) DESC, created_at DESC"
            ).fetchall()
        with self._lock:
            self._jobs = {row["job_id"]: self._row_to_job(row) for row in rows}

    def create_job(self, filename: str, audio_path: str = "") -> str:
        job_id = uuid.uuid4().hex
        now = datetime.now().isoformat()
        job = {
            "job_id": job_id,
            "filename": filename,
            "audio_path": audio_path,
            "status": "queued",
            "progress": 0,
            "message": "等待开始",
            "segments": [],
            "markdown": "",
            "error": "",
            "queue_position": None,
            "created_at": now,
            "updated_at": now,
        }
        with self._lock:
            self._jobs[job_id] = job
        self._persist_job(job)
        return job_id

    def update_job(self, job_id: str, **fields: Any) -> None:
        with self._lock:
            job = self._jobs.get(job_id)
            if not job:
                return
            job.update(fields)
            job["updated_at"] = datetime.now().isoformat()
            snapshot = dict(job)
        self._persist_job(snapshot)

    def get_job(self, job_id: str) -> dict[str, Any] | None:
        with self._lock:
            job = self._jobs.get(job_id)
            if job is None:
                return None
            return dict(job)

    def list_jobs(self, limit: int = 100) -> list[dict[str, Any]]:
        with self._lock:
            jobs = sorted(
                self._jobs.values(),
                key=lambda item: item.get("updated_at", item.get("created_at", "")),
                reverse=True,
            )
            return [dict(job) for job in jobs[:limit]]

    def get_queue_position(self, job_id: str) -> int | None:
        with self._lock:
            job = self._jobs.get(job_id)
            if job is None:
                return None
            return job.get("queue_position")


class UpdateTranscriptionJobPayload(BaseModel):
    markdown: str


class AsrEngine:
    def __init__(self) -> None:
        self.model = None
        self.model_kwargs: dict[str, Any] = {}
        self.ready = False
        self.model_path = ""
        self.last_error = ""
        self.last_warning = ""
        self.is_downloading = False
        self.is_initializing = False
        self.model_complete = False
        self.diarization_supported = False
        self._init_lock = threading.Lock()

    def _start_init_async(self, force_download: bool = False, auto_download: bool = True) -> None:
        with self._init_lock:
            if self.is_initializing:
                return
            self.is_initializing = True

        def _task() -> None:
            try:
                self._init_model(force_download=force_download, auto_download=auto_download)
            finally:
                self.is_initializing = False

        threading.Thread(target=_task, daemon=True, name="asr-engine-init").start()

    def ensure_initialized(self, force_download: bool = False, auto_download: bool = True) -> None:
        if self.ready:
            return
        self._start_init_async(force_download=force_download, auto_download=auto_download)

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
                # Fun-ASR-Nano-2512 official repo implementation does not yet expose speaker diarization.
                self.diarization_supported = False
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
            if not self.ready:
                self._start_init_async(force_download=False, auto_download=False)
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

    def _normalize_audio_for_inference(self, audio_path: Path) -> tuple[Path, bool]:
        try:
            with wave.open(str(audio_path), "rb") as wav_file:
                if wav_file.getframerate() == 16000 and wav_file.getnchannels() == 1:
                    return audio_path, False
        except wave.Error:
            pass

        normalized_path = Path(tempfile.mkstemp(prefix="meetingnote_asr_normalized_", suffix=".wav")[1])
        cmd = [
            FFMPEG_BIN,
            "-y",
            "-nostdin",
            "-hide_banner",
            "-loglevel",
            "error",
            "-i",
            str(audio_path),
            "-ar",
            "16000",
            "-ac",
            "1",
            str(normalized_path),
        ]
        completed = run_logged_subprocess(
            cmd,
            source="normalize_audio",
            capture_output=True,
            text=True,
            check=True,
        )
        if completed.returncode != 0 or not normalized_path.exists():
            raise RuntimeError((completed.stderr or completed.stdout or "音频规范化失败").strip())
        return normalized_path, True

    def _get_audio_duration_seconds(self, audio_path: Path) -> float:
        with wave.open(str(audio_path), "rb") as wav_file:
            frame_count = wav_file.getnframes()
            frame_rate = wav_file.getframerate()
            if frame_rate <= 0:
                return 0.0
            return max(0.0, frame_count / frame_rate)

    def _split_audio_chunks(self, audio_path: Path, chunk_seconds: int) -> list[tuple[Path, int]]:
        duration_seconds = self._get_audio_duration_seconds(audio_path)
        print(f"[INFO] audio duration: {duration_seconds:.2f}s for {audio_path}")
        if duration_seconds <= 0:
            return [(audio_path, 0)]

        chunk_dir = Path(tempfile.mkdtemp(prefix="meetingnote_asr_chunks_"))
        chunks: list[tuple[Path, int]] = []
        with wave.open(str(audio_path), "rb") as source_wav:
            frame_rate = source_wav.getframerate()
            frame_width = source_wav.getsampwidth()
            channel_count = source_wav.getnchannels()
            chunk_frames = max(1, int(chunk_seconds * frame_rate))

            if duration_seconds <= MAX_SINGLE_PASS_SECONDS:
                total_chunks = 1
            else:
                total_chunks = max(1, math.ceil(duration_seconds / chunk_seconds))
            print(f"[INFO] preparing {total_chunks} chunk(s), chunk_seconds={chunk_seconds}")

            for index in range(total_chunks):
                start_frame = index * chunk_frames
                source_wav.setpos(min(start_frame, source_wav.getnframes()))
                frames = source_wav.readframes(chunk_frames)
                if not frames:
                    continue
                chunk_path = chunk_dir / f"chunk_{index:03d}.wav"
                with wave.open(str(chunk_path), "wb") as chunk_wav:
                    chunk_wav.setnchannels(channel_count)
                    chunk_wav.setsampwidth(frame_width)
                    chunk_wav.setframerate(frame_rate)
                    chunk_wav.writeframes(frames)
                if chunk_path.exists() and chunk_path.stat().st_size > 0:
                    offset_ms = int(start_frame / frame_rate * 1000)
                    print(f"[INFO] prepared chunk {index + 1}/{total_chunks}: {chunk_path}")
                    chunks.append((chunk_path, offset_ms))

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
            if self.is_initializing:
                self.last_error = "ASR 模型仍在初始化，请稍后重试"
            elif self.is_downloading:
                self.last_error = "ASR 模型仍在下载，请稍后重试"
            elif not self.model_complete:
                self.last_error = "ASR 模型尚未准备完成"
            else:
                self.last_error = self.last_error or "ASR 引擎尚未就绪"
            return []

        try:
            self.last_error = ""
            prepared_audio_path, should_cleanup_prepared = self._normalize_audio_for_inference(audio_path)
            chunks = self._split_audio_chunks(prepared_audio_path, CHUNK_SECONDS)
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
        except (_JobPaused, _JobCancelled):
            raise
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
            try:
                if "should_cleanup_prepared" in locals() and should_cleanup_prepared:
                    prepared_audio_path.unlink(missing_ok=True)
            except Exception:
                pass

    def _normalize_result(self, result: Any) -> list[dict[str, Any]]:
        segments: list[dict[str, Any]] = []
        has_explicit_speaker = False
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
                if spk is None:
                    spk = item.get("speaker")
                if spk is None:
                    spk = item.get("speaker_id")
                if spk is not None:
                    has_explicit_speaker = True
                speaker = f"Speaker {spk}" if spk is not None else "Speaker"
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
            segments = [{"speaker": "Speaker", "start_ms": 0, "end_ms": 5000, "text": text}]

        self.last_warning = ""
        if not has_explicit_speaker:
            self.last_warning = (
                "当前模型未返回说话人ID（speaker diarization 未生效），结果中的 Speaker 标签不区分具体说话人。"
            )
        return merge_segments(segments)


engine = AsrEngine()
job_store = TranscriptionJobStore()
job_queue: queue.Queue[tuple[str, Path]] = queue.Queue()
print(f"[INFO] ffmpeg binary: {FFMPEG_BIN}")


@app.on_event("startup")
def warmup_asr_engine() -> None:
    _recover_incomplete_jobs()
    # Warm the ASR model only after lightweight services are already up.
    engine.ensure_initialized(auto_download=False)

# ---------------------------------------------------------------------------
# Job control signals: allow pausing / cancelling running or queued jobs.
# ---------------------------------------------------------------------------
_job_control: dict[str, str] = {}  # job_id -> "pause" | "cancel"
_job_control_lock = threading.Lock()


class _JobPaused(Exception):
    """Raised inside a running job when a pause signal is detected."""


class _JobCancelled(Exception):
    """Raised inside a running job when a cancel signal is detected."""


def _check_job_control(job_id: str) -> None:
    """Check for pending control signals; raise if pause/cancel requested."""
    with _job_control_lock:
        signal = _job_control.pop(job_id, None)
    if signal == "pause":
        raise _JobPaused()
    if signal == "cancel":
        raise _JobCancelled()


def _get_job_control_signal(job_id: str) -> str | None:
    with _job_control_lock:
        return _job_control.get(job_id)


def render_markdown(segments: list[dict[str, Any]]) -> str:
    lines: list[str] = []
    for seg in segments:
        start = ms_to_hhmmss(seg["start_ms"])
        end = ms_to_hhmmss(seg["end_ms"])
        lines.append(f"[{start} - {end}]")
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
            "initializing": engine.is_initializing,
            "model_path": engine.model_path,
            "model_exists": MODEL_DIR.exists(),
            "model_complete": engine.model_complete,
            "is_downloading": engine.is_downloading,
            "diarization_supported": engine.diarization_supported,
            "last_error": engine.last_error,
            "last_warning": engine.last_warning,
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
        "initializing": engine.is_initializing,
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
    return JSONResponse(
        {
            "segments": segments,
            "markdown": markdown,
            "warning": engine.last_warning,
            "diarization_supported": engine.diarization_supported,
        }
    )


def _run_transcription_job(job_id: str, tmp_path: Path) -> None:
    def report(progress: int, message: str, segments_snapshot: list[dict[str, Any]] | None = None) -> None:
        # Check for pause / cancel signals at every progress checkpoint.
        _check_job_control(job_id)

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
        # Pre-flight control check before starting any work.
        _check_job_control(job_id)

        report(5, "正在校验音频文件")
        report(15, "正在加载整段音频")
        segments = engine.transcribe_file(tmp_path, progress_callback=report)
        if not segments:
            job_store.update_job(
                job_id,
                status="failed",
                progress=100,
                message="转写失败",
                error=engine.last_error or "未生成转录结果",
            )
            return

        markdown = render_markdown(segments)
        final_message = "转写完成"
        if engine.last_warning:
            final_message = f"{final_message}（{engine.last_warning}）"
        job_store.update_job(
            job_id,
            status="completed",
            progress=100,
            message=final_message,
            segments=segments,
            markdown=markdown,
            error="",
        )
    except _JobPaused:
        job = job_store.get_job(job_id)
        current_progress = job["progress"] if job else 0
        job_store.update_job(
            job_id,
            status="paused",
            progress=current_progress,
            message="已暂停",
        )
        print(f"[INFO] Job {job_id} paused at progress={current_progress}")
    except _JobCancelled:
        job_store.update_job(
            job_id,
            status="cancelled",
            progress=0,
            message="已取消",
        )
        print(f"[INFO] Job {job_id} cancelled.")
    except Exception as exc:
        job_store.update_job(
            job_id,
            status="failed",
            progress=100,
            message="转写失败",
            error=str(exc),
        )
    finally:
        # Keep persisted uploads for retry/resume.
        if tmp_path.parent != UPLOAD_DIR:
            try:
                tmp_path.unlink(missing_ok=True)
            except Exception:
                pass


def _refresh_queue_positions() -> None:
    queued_items = list(job_queue.queue)
    active_queue_index = 0
    for queued_job_id, _tmp_path in queued_items:
        job = job_store.get_job(queued_job_id)
        pending_signal = _get_job_control_signal(queued_job_id)
        if pending_signal in ("pause", "cancel"):
            continue
        if not job or job.get("status") != "queued":
            continue
        active_queue_index += 1
        job_store.update_job(
            queued_job_id,
            status="queued",
            progress=0,
            queue_position=active_queue_index,
            message=f"排队中，前面还有 {active_queue_index - 1} 个任务",
        )


def _recover_incomplete_jobs() -> None:
    """
    Rebuild the in-memory queue for jobs interrupted by a previous app crash
    or forced exit. Persisted jobs in non-terminal states are not actually
    running after process restart until we enqueue them again.
    """
    recoverable_statuses = {"queued", "processing", "pausing"}
    jobs = sorted(
        job_store.list_jobs(limit=5000),
        key=lambda item: (
            item.get("queue_position") if item.get("queue_position") is not None else 10_000,
            item.get("created_at", ""),
        ),
    )

    recovered_count = 0
    for job in jobs:
        status = str(job.get("status") or "")
        if status not in recoverable_statuses:
            continue

        job_id = str(job["job_id"])
        audio_path = Path(str(job.get("audio_path") or ""))
        if not audio_path.exists():
            job_store.update_job(
                job_id,
                status="failed",
                progress=100,
                queue_position=0,
                message="恢复任务失败",
                error="audio not found",
            )
            continue

        with _job_control_lock:
            _job_control.pop(job_id, None)

        job_queue.put((job_id, audio_path))
        recovered_count += 1
        job_store.update_job(
            job_id,
            status="queued",
            progress=0,
            queue_position=job_queue.qsize(),
            message="应用异常中断后已恢复，等待继续处理",
            error="",
        )

    if recovered_count:
        print(f"[INFO] Recovered {recovered_count} interrupted job(s) into the queue.")
    _refresh_queue_positions()


def _transcription_worker_loop() -> None:
    while True:
        job_id, tmp_path = job_queue.get()
        try:
            if not engine.ready and (engine.is_initializing or engine.is_downloading or engine.model_complete):
                job_store.update_job(
                    job_id,
                    status="queued",
                    progress=0,
                    queue_position=max(1, job_queue.qsize() + 1),
                    message="等待 ASR 服务准备完成",
                )
                job_queue.put((job_id, tmp_path))
                time.sleep(1)
                continue

            # Skip jobs that were cancelled/paused while still in the queue.
            with _job_control_lock:
                pending_signal = _job_control.pop(job_id, None)
            if pending_signal == "cancel":
                job_store.update_job(
                    job_id,
                    status="cancelled",
                    progress=0,
                    queue_position=0,
                    message="已取消",
                )
                continue
            if pending_signal == "pause":
                job = job_store.get_job(job_id)
                current_progress = job["progress"] if job else 0
                job_store.update_job(
                    job_id,
                    status="paused",
                    progress=current_progress,
                    queue_position=0,
                    message="已暂停",
                )
                continue

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
    # Persist uploaded audio to allow retry/resume without re-uploading.
    job_id = job_store.create_job(file.filename or "upload.wav")
    upload_path = UPLOAD_DIR / f"{job_id}{suffix}"
    with open(upload_path, "wb") as out:
        while True:
            chunk = await file.read(1024 * 1024)
            if not chunk:
                break
            out.write(chunk)

    job_store.update_job(job_id, audio_path=str(upload_path))
    job_queue.put((job_id, upload_path))
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


@app.post("/api/transcribe/jobs/{job_id}/retry")
def retry_transcription_job(job_id: str) -> JSONResponse:
    job = job_store.get_job(job_id)
    if job is None:
        return JSONResponse({"error": "job not found"}, status_code=404)
    audio_path = Path(str(job.get("audio_path") or ""))
    if not audio_path.exists():
        return JSONResponse({"error": "audio not found"}, status_code=409)

    job_queue.put((job_id, audio_path))
    queue_position = job_queue.qsize()
    job_store.update_job(
        job_id,
        status="queued",
        progress=0,
        queue_position=queue_position,
        message=f"已重新进入队列，前面还有 {queue_position - 1} 个任务",
        error="",
    )
    _refresh_queue_positions()
    return JSONResponse({"ok": True, "job_id": job_id})


@app.post("/api/transcribe/jobs/{job_id}/pause")
def pause_transcription_job(job_id: str) -> JSONResponse:
    """Pause a queued or processing job."""
    job = job_store.get_job(job_id)
    if job is None:
        return JSONResponse({"error": "job not found"}, status_code=404)
    if job["status"] not in ("queued", "processing"):
        return JSONResponse(
            {"error": f"cannot pause job in status '{job['status']}'"},
            status_code=409,
        )
    with _job_control_lock:
        _job_control[job_id] = "pause"
    # For queued jobs, mark immediately (worker will also check on dequeue).
    if job["status"] == "queued":
        job_store.update_job(
            job_id,
            status="paused",
            queue_position=0,
            message="已暂停",
        )
    return JSONResponse({"ok": True, "job_id": job_id})


@app.post("/api/transcribe/jobs/{job_id}/cancel")
def cancel_transcription_job(job_id: str) -> JSONResponse:
    """Cancel a queued, processing, or paused job."""
    job = job_store.get_job(job_id)
    if job is None:
        return JSONResponse({"error": "job not found"}, status_code=404)
    if job["status"] not in ("queued", "processing", "paused"):
        return JSONResponse(
            {"error": f"cannot cancel job in status '{job['status']}'"},
            status_code=409,
        )
    with _job_control_lock:
        _job_control[job_id] = "cancel"
    # For queued/paused jobs, mark immediately.
    if job["status"] in ("queued", "paused"):
        job_store.update_job(
            job_id,
            status="cancelled",
            progress=0,
            queue_position=0,
            message="已取消",
        )
    return JSONResponse({"ok": True, "job_id": job_id})


@app.post("/api/transcribe/jobs/{job_id}/resume")
def resume_transcription_job(job_id: str) -> JSONResponse:
    """Resume a paused, cancelled, or failed job by re-queuing it."""
    job = job_store.get_job(job_id)
    if job is None:
        return JSONResponse({"error": "job not found"}, status_code=404)
    if job["status"] not in ("paused", "cancelled", "failed"):
        return JSONResponse(
            {"error": f"cannot resume job in status '{job['status']}'"},
            status_code=409,
        )
    audio_path = Path(str(job.get("audio_path") or ""))
    if not audio_path.exists():
        return JSONResponse({"error": "audio not found"}, status_code=409)

    # Clear any stale control signals for this job.
    with _job_control_lock:
        _job_control.pop(job_id, None)

    job_queue.put((job_id, audio_path))
    queue_position = job_queue.qsize()
    job_store.update_job(
        job_id,
        status="queued",
        progress=0,
        queue_position=queue_position,
        message=f"已恢复，等待处理",
        error="",
    )
    _refresh_queue_positions()
    return JSONResponse({"ok": True, "job_id": job_id})


@app.get("/api/transcribe/jobs/{job_id}")
def get_transcription_job(job_id: str) -> JSONResponse:
    job = job_store.get_job(job_id)
    if job is None:
        return JSONResponse({"error": "job not found"}, status_code=404)
    return JSONResponse(job)


@app.get("/api/transcribe/jobs")
def list_transcription_jobs(limit: int = 100) -> JSONResponse:
    limit = max(1, min(limit, 500))
    return JSONResponse({"jobs": job_store.list_jobs(limit=limit)})


@app.patch("/api/transcribe/jobs/{job_id}")
def update_transcription_job(job_id: str, payload: UpdateTranscriptionJobPayload) -> JSONResponse:
    job = job_store.get_job(job_id)
    if job is None:
        return JSONResponse({"error": "job not found"}, status_code=404)

    job_store.update_job(job_id, markdown=payload.markdown)
    updated_job = job_store.get_job(job_id)
    return JSONResponse(updated_job)


if __name__ == "__main__":
    uvicorn.run(app, host="127.0.0.1", port=8765)
