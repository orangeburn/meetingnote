"use client";

import { useEffect, useRef, useState } from "react";
import axios from "axios";
import { ModelDownloadModal } from "@/components/ModelDownloadModal";

type Segment = {
  speaker: string;
  start_ms: number;
  end_ms: number;
  text: string;
};

type JobStatus = "idle" | "uploading" | "queued" | "processing" | "completed" | "failed";

const API_BASE = "http://127.0.0.1:8765";

function msToTime(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600)
    .toString()
    .padStart(2, "0");
  const m = Math.floor((totalSec % 3600) / 60)
    .toString()
    .padStart(2, "0");
  const s = Math.floor(totalSec % 60)
    .toString()
    .padStart(2, "0");
  return `${h}:${m}:${s}`;
}

function renderMarkdown(segments: Segment[]): string {
  const lines = ["# 会议转写", "", `- 生成时间：${new Date().toLocaleString()}`, ""];
  for (const seg of segments) {
    lines.push(`[${msToTime(seg.start_ms)} - ${msToTime(seg.end_ms)}] [${seg.speaker}]`);
    lines.push(seg.text || "");
    lines.push("");
  }
  return lines.join("\n");
}

export default function HomePage() {
  const [segments, setSegments] = useState<Segment[]>([]);
  const [markdown, setMarkdown] = useState("# 会议转写\n");
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [status, setStatus] = useState<JobStatus>("idle");
  const [statusText, setStatusText] = useState("等待上传音频文件");
  const [progress, setProgress] = useState(0);
  const [jobId, setJobId] = useState<string | null>(null);
  const pollingRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    return () => {
      if (pollingRef.current) {
        clearInterval(pollingRef.current);
      }
    };
  }, []);

  function resetResultArea() {
    setSegments([]);
    setMarkdown("# 会议转写\n");
  }

  async function pollJob(nextJobId: string) {
    try {
      const resp = await axios.get(`${API_BASE}/api/transcribe/jobs/${nextJobId}`);
      const data = resp.data;
      const nextStatus = (data.status || "processing") as JobStatus;
      const nextSegments = (data.segments || []) as Segment[];
      setStatus(nextStatus);
      setProgress(Number(data.progress || 0));
      setStatusText(data.message || "处理中");

      if (nextSegments.length > 0) {
        setSegments(nextSegments);
        setMarkdown(data.markdown || renderMarkdown(nextSegments));
      }

      if (nextStatus === "completed") {
        setSegments(nextSegments);
        setMarkdown(data.markdown || renderMarkdown(nextSegments));
        if (pollingRef.current) {
          clearInterval(pollingRef.current);
          pollingRef.current = null;
        }
      }

      if (nextStatus === "failed") {
        resetResultArea();
        setStatusText(data.error || data.message || "转写失败");
        if (pollingRef.current) {
          clearInterval(pollingRef.current);
          pollingRef.current = null;
        }
      }
    } catch (error: any) {
      setStatus("failed");
      setStatusText(error?.response?.data?.error || error?.message || "任务状态获取失败");
      if (pollingRef.current) {
        clearInterval(pollingRef.current);
        pollingRef.current = null;
      }
    }
  }

  async function transcribeFile() {
    if (!selectedFile) return;

    if (pollingRef.current) {
      clearInterval(pollingRef.current);
      pollingRef.current = null;
    }

    resetResultArea();
    setJobId(null);
    setStatus("uploading");
    setStatusText("正在上传音频文件");
    setProgress(0);

    const form = new FormData();
    form.append("file", selectedFile);

    try {
      const resp = await axios.post(`${API_BASE}/api/transcribe/jobs`, form, {
        headers: { "Content-Type": "multipart/form-data" },
        onUploadProgress: (event) => {
          if (!event.total) return;
          const uploadPercent = Math.min(25, Math.round((event.loaded / event.total) * 25));
          setProgress(uploadPercent);
          setStatus("uploading");
          setStatusText(`正在上传音频文件 ${uploadPercent}%`);
        },
      });

      const nextJobId = resp.data?.job_id as string;
      setJobId(nextJobId);
      setStatus("processing");
      setStatusText("文件上传完成，开始转写");
      setProgress((prev) => Math.max(prev, 26));
      await pollJob(nextJobId);
      pollingRef.current = setInterval(() => {
        void pollJob(nextJobId);
      }, 800);
    } catch (error: any) {
      setStatus("failed");
      setProgress(100);
      setStatusText(error?.response?.data?.error || error?.message || "转写失败");
    }
  }

  function exportMd() {
    const blob = new Blob([markdown], { type: "text/markdown;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `meeting-note-${Date.now()}.md`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <main className="meetingnote-shell min-h-screen">
      <ModelDownloadModal />
      <div className="mx-auto flex min-h-screen w-full max-w-7xl flex-col px-4 py-6 sm:px-6 lg:px-8">
        <section className="hero-panel">
          <div>
            <div className="eyebrow">MeetingNote</div>
            <h1 className="hero-title">上传音频，生成可编辑的会议转写稿。</h1>
            <p className="hero-copy">
              仅保留文件转写流程，输出按说话人和时间戳分段，并支持实时编辑与导出。
            </p>
          </div>
          <div className="hero-status-card">
            <div className={`status-dot status-${status}`} />
            <div>
              <div className="text-sm text-slate-500">当前状态</div>
              <div className="text-base font-semibold text-slate-900">{statusText}</div>
            </div>
          </div>
        </section>

        <section className="workspace-grid mt-6">
          <div className="panel-card">
            <div className="panel-header">
              <div>
                <div className="panel-kicker">步骤 1</div>
                <h2 className="panel-title">上传音频文件</h2>
              </div>
            </div>

            <label className="upload-dropzone">
              <input
                type="file"
                accept="audio/*"
                className="hidden"
                onChange={(e) => {
                  const file = e.target.files?.[0] || null;
                  setSelectedFile(file);
                  if (file) {
                    setStatus("idle");
                    setStatusText("已选择文件，准备开始转写");
                    setProgress(0);
                  }
                }}
              />
              <span className="upload-badge">仅支持上传音频文件</span>
              <strong className="text-lg text-slate-900">{selectedFile ? selectedFile.name : "点击选择或拖入音频文件"}</strong>
              <span className="text-sm text-slate-500">
                {selectedFile
                  ? `${(selectedFile.size / 1024 / 1024).toFixed(2)} MB`
                  : "支持常见音频格式，转写后会保留说话人和时间戳"}
              </span>
            </label>

            <button
              onClick={transcribeFile}
              disabled={!selectedFile || status === "uploading" || status === "processing"}
              className="primary-button mt-5"
            >
              {status === "uploading" || status === "processing" ? "转写进行中..." : "开始转写"}
            </button>

            <div className="progress-card mt-5">
              <div className="flex items-center justify-between text-sm">
                <span className="font-medium text-slate-700">转写进度</span>
                <span className="text-slate-500">{progress}%</span>
              </div>
              <div className="progress-track mt-3">
                <div className="progress-fill" style={{ width: `${progress}%` }} />
              </div>
              <p className="mt-3 text-sm text-slate-500">
                {jobId ? `任务 ID: ${jobId.slice(0, 8)}` : "创建任务后会持续显示上传与转写进度"}
              </p>
            </div>
          </div>

          <div className="panel-card">
            <div className="panel-header">
              <div>
                <div className="panel-kicker">步骤 2</div>
                <h2 className="panel-title">分段结果</h2>
              </div>
            </div>

            <div className="segment-list">
              {segments.length === 0 ? (
                <div className="empty-state">
                  <p className="text-base font-semibold text-slate-800">暂无转写内容</p>
                  <p className="mt-2 text-sm text-slate-500">完成转写后，这里会显示带说话人和时间戳的逐段结果。</p>
                </div>
              ) : (
                segments.map((seg, idx) => (
                  <article key={`${seg.start_ms}-${idx}`} className="segment-card">
                    <div className="segment-meta">
                      <span>{seg.speaker}</span>
                      <span>
                        {msToTime(seg.start_ms)} - {msToTime(seg.end_ms)}
                      </span>
                    </div>
                    <p className="segment-text">{seg.text}</p>
                  </article>
                ))
              )}
            </div>
          </div>
        </section>

        <section className="panel-card mt-6">
          <div className="panel-header">
            <div>
              <div className="panel-kicker">步骤 3</div>
              <h2 className="panel-title">Markdown 编辑器</h2>
            </div>
            <button onClick={exportMd} className="secondary-button" disabled={!markdown.trim()}>
              导出 .md
            </button>
          </div>

          <textarea
            value={markdown}
            onChange={(e) => setMarkdown(e.target.value)}
            className="editor-area"
            placeholder="转写完成后，这里会生成可继续编辑的 Markdown 内容。"
          />
        </section>
      </div>
    </main>
  );
}
