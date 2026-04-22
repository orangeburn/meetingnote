"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import axios from "axios";
import { ModelDownloadModal } from "@/components/ModelDownloadModal";
import {
  createTaskFromFile,
  fetchTasksFromApi,
  formatFileSize,
  loadTasks,
  mergeTaskSources,
  normalizeTask,
  renderMarkdown,
  saveTasks,
  sortTasks,
  updateTaskCollection,
  type JobStatus,
  type Segment,
  type TranscriptionTask,
} from "@/lib/tasks";

const API_BASE = "http://127.0.0.1:8765";

export default function HomePage() {
  const [tasks, setTasks] = useState<TranscriptionTask[]>([]);
  const pollingRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const activeTaskIdRef = useRef<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    const localTasks = sortTasks(loadTasks().map(normalizeTask));
    setTasks(localTasks);

    void (async () => {
      try {
        const apiTasks = await fetchTasksFromApi();
        const merged = mergeTaskSources(localTasks, apiTasks);
        setTasks(merged);
        saveTasks(merged);
      } catch {
        setTasks(localTasks);
      }
    })();
  }, []);

  useEffect(() => {
    const resumableTask = tasks.find(
      (task) =>
        task.jobId &&
        (task.status === "uploading" || task.status === "queued" || task.status === "processing")
    );

    if (!resumableTask || activeTaskIdRef.current === resumableTask.id || pollingRef.current) {
      return;
    }

    const resumableJobId = resumableTask.jobId;
    if (!resumableJobId) {
      return;
    }

    activeTaskIdRef.current = resumableTask.id;
    void pollJob(resumableTask.id, resumableJobId);
    pollingRef.current = setInterval(() => {
      void pollJob(resumableTask.id, resumableJobId);
    }, 800);

    return () => {
      if (pollingRef.current && activeTaskIdRef.current === resumableTask.id) {
        clearInterval(pollingRef.current);
        pollingRef.current = null;
        activeTaskIdRef.current = null;
      }
    };
  }, [tasks]);

  useEffect(() => {
    saveTasks(tasks);
  }, [tasks]);

  useEffect(() => {
    return () => {
      if (pollingRef.current) {
        clearInterval(pollingRef.current);
      }
    };
  }, []);

  async function pollJob(taskId: string, nextJobId: string) {
    try {
      const resp = await axios.get(`${API_BASE}/api/transcribe/jobs/${nextJobId}`);
      const data = resp.data;
      const nextStatus = (data.status || "processing") as JobStatus;
      const nextSegments = (data.segments || []) as Segment[];
      const nextProgress = Number(data.progress || 0);
      const nextStatusText = data.message || "处理中";

      setTasks((current) =>
        sortTasks(
          updateTaskCollection(current, taskId, (task) => ({
            ...task,
            status: nextStatus,
            progress: nextProgress,
            statusText: nextStatus === "failed" ? data.error || nextStatusText : nextStatusText,
            segments: nextSegments.length > 0 ? nextSegments : task.segments,
            markdown:
              nextSegments.length > 0 ? data.markdown || renderMarkdown(nextSegments) : task.markdown,
            updatedAt: new Date().toISOString(),
            error: nextStatus === "failed" ? data.error || nextStatusText : undefined,
          }))
        )
      );

      if (nextStatus === "completed" || nextStatus === "failed") {
        if (pollingRef.current) {
          clearInterval(pollingRef.current);
          pollingRef.current = null;
        }
        activeTaskIdRef.current = null;
      }
    } catch (error: any) {
      setTasks((current) =>
        sortTasks(
          updateTaskCollection(current, taskId, (task) => ({
            ...task,
            status: "failed",
            statusText: error?.response?.data?.error || error?.message || "任务状态获取失败",
            error: error?.response?.data?.error || error?.message || "任务状态获取失败",
            updatedAt: new Date().toISOString(),
          }))
        )
      );
      if (pollingRef.current) {
        clearInterval(pollingRef.current);
        pollingRef.current = null;
      }
      activeTaskIdRef.current = null;
    }
  }

  async function transcribeFile(file: File) {
    if (pollingRef.current) {
      clearInterval(pollingRef.current);
      pollingRef.current = null;
    }

    const nextTask = createTaskFromFile(file);
    activeTaskIdRef.current = nextTask.id;
    setTasks((current) => sortTasks([normalizeTask(nextTask), ...current]));

    const form = new FormData();
    form.append("file", file);

    try {
      const resp = await axios.post(`${API_BASE}/api/transcribe/jobs`, form, {
        headers: { "Content-Type": "multipart/form-data" },
        onUploadProgress: (event) => {
          if (!event.total) return;
          const uploadPercent = Math.min(25, Math.round((event.loaded / event.total) * 25));
          setTasks((current) =>
            sortTasks(
              updateTaskCollection(current, nextTask.id, (task) => ({
                ...task,
                status: "uploading",
                progress: uploadPercent,
                statusText: `上传中 ${uploadPercent}%`,
                updatedAt: new Date().toISOString(),
              }))
            )
          );
        },
      });

      const nextJobId = resp.data?.job_id as string;
      setTasks((current) =>
        sortTasks(
          updateTaskCollection(current, nextTask.id, (task) => ({
            ...task,
            id: nextJobId,
            jobId: nextJobId,
            status: "processing",
            statusText: "转录中",
            progress: Math.max(task.progress, 26),
            updatedAt: new Date().toISOString(),
          }))
        )
      );
      activeTaskIdRef.current = nextJobId;
      await pollJob(nextJobId, nextJobId);
      pollingRef.current = setInterval(() => {
        void pollJob(nextJobId, nextJobId);
      }, 800);
    } catch (error: any) {
      setTasks((current) =>
        sortTasks(
          updateTaskCollection(current, nextTask.id, (task) => ({
            ...task,
            status: "failed",
            progress: 100,
            statusText: error?.response?.data?.error || error?.message || "转写失败",
            error: error?.response?.data?.error || error?.message || "转写失败",
            updatedAt: new Date().toISOString(),
          }))
        )
      );
      activeTaskIdRef.current = null;
    }
  }

  function getStatusLabel(status: JobStatus) {
    if (status === "uploading") return "上传中";
    if (status === "processing" || status === "queued") return "转录中";
    if (status === "completed") return "已完成";
    if (status === "failed") return "失败";
    return "待开始";
  }

  return (
    <main className="meetingnote-shell min-h-screen">
      <ModelDownloadModal />
      <div className="mx-auto flex min-h-screen w-full max-w-7xl flex-col px-4 py-6 sm:px-6 lg:px-8">
        <section className="compact-hero">
          <div className="compact-hero-copy">
            <div className="eyebrow">MeetingNote</div>
            <h1 className="compact-title">转录任务</h1>
          </div>
        </section>

        <input
          ref={fileInputRef}
          type="file"
          accept="audio/*"
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) {
              void transcribeFile(file);
            }
            e.currentTarget.value = "";
          }}
        />

        <section className="task-grid mt-6">
          <button
            className="task-card task-card-create"
            onClick={() => fileInputRef.current?.click()}
            type="button"
          >
            <div className="task-card-plus" aria-hidden="true">
              <span />
              <span />
            </div>
            <div className="task-card-title">新建任务</div>
          </button>

          {tasks.map((task) =>
            task.status === "completed" ? (
              <Link key={task.id} href={`/tasks/${task.id}`} className={`task-card task-status-${task.status}`}>
                <div className="task-card-head">
                  <span className="task-state-pill">{getStatusLabel(task.status)}</span>
                  <span className="task-progress">{task.progress}%</span>
                </div>
                <div className="task-card-title">{task.title}</div>
                <div className="task-card-meta">
                  {task.fileName} · {formatFileSize(task.fileSize)}
                </div>
                <div className="task-card-footer">
                  <span>{new Date(task.updatedAt).toLocaleString()}</span>
                  <span>查看结果</span>
                </div>
              </Link>
            ) : (
              <article
                key={task.id}
                className={`task-card task-status-${task.status} ${task.status === "processing" || task.status === "uploading" ? "task-card-live" : ""}`}
              >
                <div className="task-card-head">
                  <span className="task-state-pill">{getStatusLabel(task.status)}</span>
                  <span className="task-progress">{task.progress}%</span>
                </div>
                <div className="task-card-title">{task.title}</div>
                <div className="task-card-meta">
                  {task.fileName} · {formatFileSize(task.fileSize)}
                </div>
                <div className="task-card-progress">
                  <div className="task-card-progress-bar" style={{ width: `${task.progress}%` }} />
                </div>
                <div className="task-card-footer">
                  <span>{task.statusText}</span>
                  <span>{new Date(task.updatedAt).toLocaleTimeString()}</span>
                </div>
              </article>
            )
          )}
        </section>
      </div>
    </main>
  );
}
