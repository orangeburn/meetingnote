"use client";

import { useMemo, useRef, useState } from "react";
import axios from "axios";

type Segment = {
  speaker: string;
  start_ms: number;
  end_ms: number;
  text: string;
};

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
  const [mode, setMode] = useState<"stream" | "file">("stream");
  const [inputSource, setInputSource] = useState<"mic" | "loopback" | "file">("mic");
  const [segments, setSegments] = useState<Segment[]>([]);
  const [markdown, setMarkdown] = useState("# 会议转写\n");
  const [isStreaming, setIsStreaming] = useState(false);
  const [status, setStatus] = useState("idle");
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const wsRef = useRef<WebSocket | null>(null);

  const canStartStream = useMemo(() => !isStreaming && (inputSource === "mic" || inputSource === "loopback"), [isStreaming, inputSource]);

  async function startStream() {
    if (!canStartStream) return;
    setStatus("connecting stream...");
    const ws = new WebSocket(`${API_BASE.replace("http", "ws")}/ws/stream?source=${inputSource}`);
    wsRef.current = ws;
    ws.onopen = () => {
      setIsStreaming(true);
      setStatus("streaming");
      ws.send(JSON.stringify({ type: "start", record: true }));
    };
    ws.onmessage = (ev) => {
      const data = JSON.parse(ev.data) as { type: string; segment?: Segment };
      if (data.type === "segment" && data.segment) {
        setSegments((prev) => {
          const next = [...prev, data.segment as Segment];
          setMarkdown(renderMarkdown(next));
          return next;
        });
      }
      if (data.type === "status") {
        setStatus("streaming");
      }
    };
    ws.onerror = () => {
      setStatus("stream error");
    };
    ws.onclose = () => {
      setIsStreaming(false);
      setStatus("stopped");
    };
  }

  function stopStream() {
    if (!wsRef.current) return;
    wsRef.current.send(JSON.stringify({ type: "stop" }));
    wsRef.current.close();
    wsRef.current = null;
    setIsStreaming(false);
    setStatus("stopped");
  }

  async function transcribeFile() {
    if (!selectedFile) return;
    setStatus("uploading...");
    const form = new FormData();
    form.append("file", selectedFile);
    const resp = await axios.post(`${API_BASE}/api/transcribe`, form, {
      headers: { "Content-Type": "multipart/form-data" }
    });
    const nextSegments = (resp.data?.segments || []) as Segment[];
    setSegments(nextSegments);
    setMarkdown(resp.data?.markdown || renderMarkdown(nextSegments));
    setStatus("done");
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
    <main className="min-h-screen p-6">
      <div className="mx-auto max-w-6xl rounded-2xl bg-white p-6 shadow-xl">
        <h1 className="text-2xl font-bold">MeetingNote</h1>
        <p className="mt-2 text-sm text-slate-600">聚焦会议场景：流式实时输出 + 文件转写 + 说话人识别 + Markdown 编辑导出</p>

        <div className="mt-6 flex flex-wrap gap-3">
          <button className={`rounded px-3 py-2 ${mode === "stream" ? "bg-blue-700 text-white" : "bg-slate-200"}`} onClick={() => setMode("stream")}>
            流式实时输出
          </button>
          <button className={`rounded px-3 py-2 ${mode === "file" ? "bg-blue-700 text-white" : "bg-slate-200"}`} onClick={() => setMode("file")}>
            语音转写（文件）
          </button>
          <span className="ml-auto rounded bg-slate-100 px-3 py-2 text-sm">状态: {status}</span>
        </div>

        <div className="mt-4 flex gap-3">
          <label className="text-sm">输入源</label>
          <select
            className="rounded border px-2 py-1"
            value={inputSource}
            onChange={(e) => setInputSource(e.target.value as "mic" | "loopback" | "file")}
          >
            <option value="mic">麦克风</option>
            <option value="loopback">本地音频输出（系统回放）</option>
            <option value="file">音频文件</option>
          </select>
        </div>

        {mode === "stream" ? (
          <div className="mt-5 flex gap-3">
            <button disabled={!canStartStream} onClick={startStream} className="rounded bg-emerald-600 px-4 py-2 text-white disabled:bg-slate-300">
              开始流式识别 + 录音
            </button>
            <button disabled={!isStreaming} onClick={stopStream} className="rounded bg-rose-600 px-4 py-2 text-white disabled:bg-slate-300">
              停止
            </button>
          </div>
        ) : (
          <div className="mt-5 flex items-center gap-3">
            <input
              type="file"
              accept="audio/*"
              onChange={(e) => {
                const f = e.target.files?.[0] || null;
                setSelectedFile(f);
                setInputSource("file");
              }}
            />
            <button onClick={transcribeFile} disabled={!selectedFile} className="rounded bg-blue-700 px-4 py-2 text-white disabled:bg-slate-300">
              上传并转写
            </button>
          </div>
        )}

        <div className="mt-6 grid grid-cols-1 gap-4 lg:grid-cols-2">
          <section className="rounded-xl border p-4">
            <h2 className="text-lg font-semibold">分段结果（说话人 + 时间戳）</h2>
            <div className="mt-3 max-h-[420px] overflow-auto">
              {segments.length === 0 ? (
                <p className="text-sm text-slate-500">暂无转写内容</p>
              ) : (
                segments.map((seg, idx) => (
                  <div key={`${seg.start_ms}-${idx}`} className="mb-3 rounded bg-slate-50 p-2">
                    <div className="text-xs text-slate-500">[{msToTime(seg.start_ms)} - {msToTime(seg.end_ms)}] [{seg.speaker}]</div>
                    <div className="text-sm">{seg.text}</div>
                  </div>
                ))
              )}
            </div>
          </section>

          <section className="rounded-xl border p-4">
            <div className="mb-2 flex items-center">
              <h2 className="text-lg font-semibold">Markdown（可实时编辑）</h2>
              <button onClick={exportMd} className="ml-auto rounded bg-slate-800 px-3 py-1 text-sm text-white">
                导出 .md
              </button>
            </div>
            <textarea
              value={markdown}
              onChange={(e) => setMarkdown(e.target.value)}
              className="h-[420px] w-full rounded border p-3 font-mono text-sm"
            />
          </section>
        </div>
      </div>
    </main>
  );
}
