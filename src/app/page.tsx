"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import axios from "axios";
import { ModelDownloadModal } from "@/components/ModelDownloadModal";
import { AppFrame, Button, PageContainer } from "@/design-system/primitives";
import {
  createTaskFromFile,
  fetchTasksFromApi,
  normalizeTask,
  renderMarkdown,
  setTaskTitleOverride,
  sortTasks,
  stripTimestamps,
  updateTaskMarkdown,
  updateTaskTitle,
  updateTaskCollection,
  pauseTask,
  cancelTask,
  resumeTask,
  type JobStatus,
  type Segment,
  type TranscriptionTask,
} from "@/lib/tasks";

const API_BASE = "http://127.0.0.1:8765";

function TaskActionIcon({ kind }: { kind: "pause" | "cancel" | "resume" | "retry" }) {
  if (kind === "pause") {
    return (
      <svg viewBox="0 0 16 16" aria-hidden="true" className="task-action-icon">
        <rect x="4" y="3" width="3" height="10" rx="1" fill="currentColor" />
        <rect x="9" y="3" width="3" height="10" rx="1" fill="currentColor" />
      </svg>
    );
  }
  if (kind === "cancel") {
    return (
      <svg viewBox="0 0 16 16" aria-hidden="true" className="task-action-icon">
        <path
          d="M4.5 4.5L11.5 11.5M11.5 4.5L4.5 11.5"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.7"
          strokeLinecap="round"
        />
      </svg>
    );
  }
  if (kind === "resume") {
    return (
      <svg viewBox="0 0 16 16" aria-hidden="true" className="task-action-icon">
        <path d="M5 3.5L12 8L5 12.5V3.5Z" fill="currentColor" />
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" className="task-action-icon">
      <path
        d="M12.5 8A4.5 4.5 0 1 1 8 3.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
      />
      <path
        d="M8 1.75H12.25V6"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export default function HomePage() {
  const [tasks, setTasks] = useState<TranscriptionTask[]>([]);
  const [activeTaskId, setActiveTaskId] = useState<string | null>(null);
  const pollingRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const activeTaskIdRef = useRef<string | null>(null);
  const manualPollingRef = useRef(false);
  const tasksRef = useRef<TranscriptionTask[]>([]);
  const queuedFilesRef = useRef<Array<{ file: File; taskId: string }>>([]);
  const processingQueueRef = useRef(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [editorDrafts, setEditorDrafts] = useState<Record<string, string>>({});
  const [titleDrafts, setTitleDrafts] = useState<Record<string, string>>({});
  const [savingTitleTaskId, setSavingTitleTaskId] = useState<string | null>(null);
  const autoRetryRef = useRef<Map<string, number>>(new Map());
  const [actionLoading, setActionLoading] = useState<string | null>(null);

  function hasActiveRemoteTask(taskList: TranscriptionTask[]) {
    return taskList.some(
      (task) =>
        Boolean(task.jobId) &&
        (
          task.status === "uploading" ||
          task.status === "queued" ||
          task.status === "processing" ||
          task.status === "pausing" ||
          task.status === "resuming"
        )
    );
  }

  function stopPolling(taskId?: string | null) {
    if (pollingRef.current) {
      clearInterval(pollingRef.current);
      pollingRef.current = null;
    }
    if (!taskId || activeTaskIdRef.current === taskId) {
      activeTaskIdRef.current = null;
    }
  }

  function startPolling(taskId: string, jobId: string) {
    stopPolling(taskId);
    activeTaskIdRef.current = taskId;
    pollingRef.current = setInterval(() => {
      void pollJob(taskId, jobId);
    }, 800);
  }

  function applyTaskOptimisticUpdate(taskId: string, updater: (task: TranscriptionTask) => TranscriptionTask) {
    setTasks((current) => sortTasks(updateTaskCollection(current, taskId, updater)));
  }

  function mergeTaskWithRemoteState(localTask: TranscriptionTask, remoteTask: TranscriptionTask): TranscriptionTask {
    const keepPausing =
      localTask.status === "pausing" &&
      (remoteTask.status === "processing" || remoteTask.status === "queued");
    const keepResuming =
      localTask.status === "resuming" &&
      (remoteTask.status === "paused" || remoteTask.status === "queued");

    if (keepPausing) {
      return {
        ...remoteTask,
        status: "pausing",
        statusText: "暂停中，将在当前片段处理完成后停止",
      };
    }

    if (keepResuming) {
      return {
        ...remoteTask,
        status: "resuming",
        statusText: "重启中，正在恢复任务处理",
      };
    }

    return remoteTask;
  }

  function exportTextWithoutTimestamps(markdown: string, fileName: string) {
    const content = stripTimestamps(markdown);
    const blob = new Blob([content], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${fileName.replace(/\.[^/.]+$/, "") || "meeting-note"}.txt`;
    a.click();
    URL.revokeObjectURL(url);
  }

  async function syncTasksFromApi() {
    try {
      const apiTasks = await fetchTasksFromApi();
      setTasks((current) => {
        const normalizedApiTasks = apiTasks.map(normalizeTask);
        const currentById = new Map(current.map((task) => [task.id, task]));
        const mergedApiTasks = normalizedApiTasks.map((task) => {
          const localTask = currentById.get(task.id);
          return localTask ? mergeTaskWithRemoteState(localTask, task) : task;
        });
        const apiIds = new Set(mergedApiTasks.map((task) => task.id));
        const localPending = current.filter(
          (task) => !apiIds.has(task.id) && !task.jobId && (task.status === "queued" || task.status === "uploading")
        );
        return sortTasks([...mergedApiTasks, ...localPending]);
      });
    } catch {
      setTasks((current) => current);
    }
  }

  useEffect(() => {
    void syncTasksFromApi();
  }, []);

  useEffect(() => {
    const handleFocus = () => {
      void syncTasksFromApi();
    };

    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        void syncTasksFromApi();
      }
    };

    window.addEventListener("focus", handleFocus);
    document.addEventListener("visibilitychange", handleVisibilityChange);

    return () => {
      window.removeEventListener("focus", handleFocus);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, []);

  useEffect(() => {
    tasksRef.current = tasks;
  }, [tasks]);

  useEffect(() => {
    const resumableTask = tasks.find(
      (task) =>
        task.jobId &&
        (
          task.status === "uploading" ||
          task.status === "queued" ||
          task.status === "processing" ||
          task.status === "pausing" ||
          task.status === "resuming"
        )
    );

    if (
      !resumableTask ||
      activeTaskIdRef.current === resumableTask.id ||
      pollingRef.current ||
      manualPollingRef.current
    ) {
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
      if (activeTaskIdRef.current === resumableTask.id) {
        stopPolling(resumableTask.id);
      }
    };
  }, [tasks]);

  useEffect(() => {
    if (queuedFilesRef.current.length === 0) {
      return;
    }
    if (hasActiveRemoteTask(tasks)) {
      return;
    }
    void processFileQueue();
  }, [tasks]);

  useEffect(() => {
    if (tasks.length === 0) {
      setActiveTaskId(null);
      return;
    }
    if (!activeTaskId || !tasks.some((task) => task.id === activeTaskId)) {
      setActiveTaskId(tasks[0].id);
    }
  }, [tasks, activeTaskId]);
  useEffect(() => {
    return () => {
      stopPolling();
    };
  }, []);

  async function pollJob(taskId: string, nextJobId: string): Promise<JobStatus> {
    try {
      const resp = await axios.get(`${API_BASE}/api/transcribe/jobs/${nextJobId}`);
      const data = resp.data;
      const nextStatus = (data.status || "processing") as JobStatus;
      const nextSegments = (data.segments || []) as Segment[];
      const nextProgress = Number(data.progress || 0);
      const nextStatusText = data.message || "处理中";

      setTasks((current) =>
        sortTasks(
          updateTaskCollection(current, taskId, (task) => {
            const shouldKeepPausing = task.status === "pausing" && nextStatus === "processing";
            const shouldKeepResuming =
              task.status === "resuming" && (nextStatus === "paused" || nextStatus === "queued");
            return {
              ...task,
              status: shouldKeepPausing ? "pausing" : shouldKeepResuming ? "resuming" : nextStatus,
              progress: nextProgress,
              statusText:
                shouldKeepPausing
                  ? "暂停中，将在当前片段处理完成后停止"
                  : shouldKeepResuming
                    ? "重启中，正在恢复任务处理"
                    : nextStatus === "failed"
                      ? data.error || nextStatusText
                      : nextStatusText,
              segments: nextSegments.length > 0 ? nextSegments : task.segments,
              markdown:
                nextSegments.length > 0 ? data.markdown || renderMarkdown(nextSegments) : task.markdown,
              updatedAt: new Date().toISOString(),
              error: nextStatus === "failed" ? data.error || nextStatusText : undefined,
            };
          })
        )
      );

      // Auto-retry: only for "failed" status, not for paused/cancelled.
      if (nextStatus === "failed") {
        const previousAttempts = autoRetryRef.current.get(nextJobId) ?? 0;
        if (previousAttempts < 2) {
          autoRetryRef.current.set(nextJobId, previousAttempts + 1);
          setTasks((current) =>
            sortTasks(
              updateTaskCollection(current, taskId, (task) => ({
                ...task,
                status: "queued",
                statusText: `失败，自动重试中（${previousAttempts + 1}/2）`,
                progress: 0,
                updatedAt: new Date().toISOString(),
              }))
            )
          );
          try {
            await resumeTask(nextJobId);
            return "queued";
          } catch (retryError: any) {
            setTasks((current) =>
              sortTasks(
                updateTaskCollection(current, taskId, (task) => ({
                  ...task,
                  status: "failed",
                  statusText:
                    retryError?.message || "自动重试失败",
                  error: retryError?.message || "自动重试失败",
                  updatedAt: new Date().toISOString(),
                }))
              )
            );
            return "failed";
          }
        }
      }

      // Terminal states: stop polling.
      const terminalStates: JobStatus[] = ["completed", "failed", "paused", "cancelled"];
      if (terminalStates.includes(nextStatus)) {
        stopPolling(taskId);
      }
      return nextStatus;
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
      stopPolling(taskId);
      return "failed";
    }
  }

  async function transcribeFile(item: { file: File; taskId: string }) {
    const file = item.file;
    const taskId = item.taskId;
    stopPolling(taskId);
    activeTaskIdRef.current = taskId;
    setTasks((current) => {
      if (current.some((task) => task.id === taskId)) return current;
      const fallbackTask = normalizeTask({
        ...createTaskFromFile(file),
        id: taskId,
        status: "queued",
        statusText: "等待中",
      });
      return sortTasks([fallbackTask, ...current]);
    });

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
              updateTaskCollection(current, taskId, (task) => ({
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
      setTasks((current) => {
        const taskIndex = current.findIndex((task) => task.id === taskId);
        if (taskIndex === -1) return current;
        const nextTasks = [...current];
        nextTasks[taskIndex] = {
          ...nextTasks[taskIndex],
          id: nextJobId,
          jobId: nextJobId,
          status: "processing",
          statusText: "转录中",
          progress: Math.max(nextTasks[taskIndex].progress, 26),
          updatedAt: new Date().toISOString(),
        };
        return sortTasks(nextTasks);
      });
      activeTaskIdRef.current = nextJobId;
      manualPollingRef.current = true;
      while (true) {
        const status = await pollJob(nextJobId, nextJobId);
        if (["completed", "failed", "paused", "cancelled"].includes(status)) {
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 800));
      }
      manualPollingRef.current = false;
    } catch (error: any) {
      setTasks((current) =>
        sortTasks(
          updateTaskCollection(current, taskId, (task) => ({
            ...task,
            status: "failed",
            progress: task.progress,
            statusText: error?.response?.data?.error || error?.message || "转写失败",
            error: error?.response?.data?.error || error?.message || "转写失败",
            updatedAt: new Date().toISOString(),
          }))
        )
      );
      stopPolling(taskId);
      manualPollingRef.current = false;
    }
  }

  async function processFileQueue() {
    if (processingQueueRef.current) return;
    if (hasActiveRemoteTask(tasksRef.current)) return;
    processingQueueRef.current = true;
    try {
      while (queuedFilesRef.current.length > 0) {
        if (hasActiveRemoteTask(tasksRef.current)) {
          break;
        }
        const nextItem = queuedFilesRef.current.shift();
        if (!nextItem) break;
        await transcribeFile(nextItem);
      }
    } finally {
      processingQueueRef.current = false;
    }
  }

  function enqueueFile(file: File) {
    const nextTask = normalizeTask({
      ...createTaskFromFile(file),
      status: "queued",
      statusText: "等待中",
    });
    setTasks((current) => sortTasks([nextTask, ...current]));
    setActiveTaskId(nextTask.id);
    queuedFilesRef.current.push({ file, taskId: nextTask.id });
    setTasks((current) => {
      if (hasActiveRemoteTask(current)) {
        return sortTasks(
          updateTaskCollection(current, nextTask.id, (task) => ({
            ...task,
            status: "queued",
            statusText: "等待当前任务完成后开始上传",
            updatedAt: new Date().toISOString(),
          }))
        );
      }
      return current;
    });
    if (!hasActiveRemoteTask(tasks)) {
      void processFileQueue();
    }
  }

  async function saveTaskTitle(task: TranscriptionTask, rawTitle: string) {
    const nextTitle = rawTitle.trim();
    if (!nextTitle || nextTitle === task.title || savingTitleTaskId === task.id) return;

    setSavingTitleTaskId(task.id);
    try {
      const updatedTask = await updateTaskTitle(task.id, nextTitle);
      setTasks((current) =>
        sortTasks(
          updateTaskCollection(current, task.id, (item) => ({
            ...item,
            ...updatedTask,
          }))
        )
      );
    } catch {
      setTasks((current) =>
        sortTasks(
          updateTaskCollection(current, task.id, (item) => ({
            ...item,
            title: nextTitle,
          }))
        )
      );
      setTaskTitleOverride(task.id, nextTitle);
    } finally {
      setSavingTitleTaskId(null);
      setTitleDrafts((current) => {
        const next = { ...current };
        delete next[task.id];
        return next;
      });
    }
  }

  function getStatusLabel(status: JobStatus) {
    if (status === "uploading") return "上传中";
    if (status === "processing") return "转录中";
    if (status === "pausing") return "暂停中";
    if (status === "resuming") return "重启中";
    if (status === "queued") return "等待中";
    if (status === "completed") return "已完成";
    if (status === "failed") return "失败";
    if (status === "paused") return "已暂停";
    if (status === "cancelled") return "已取消";
    return "待开始";
  }

  function renderStatusIndicator(status: JobStatus) {
    if (status === "uploading") {
      return (
        <span
          className="task-state-pill task-state-pill-icon task-state-pill-uploading"
          title="上传中"
          aria-label="上传中"
        >
          <span className="task-state-upload-icon" aria-hidden="true">
            ↑
          </span>
        </span>
      );
    }
    if (status === "processing") {
      return (
        <span className="task-state-pill task-state-pill-icon" title="转录中" aria-label="转录中">
          <span className="task-state-wave" aria-hidden="true">
            <span />
            <span />
            <span />
            <span />
          </span>
        </span>
      );
    }
    if (status === "pausing") {
      return (
        <span
          className="task-state-pill task-state-pill-icon task-state-pill-pausing"
          title="暂停中"
          aria-label="暂停中"
        >
          <span className="task-state-pausing-icon" aria-hidden="true">
            <span />
            <span />
          </span>
        </span>
      );
    }
    if (status === "resuming") {
      return (
        <span
          className="task-state-pill task-state-pill-icon task-state-pill-resuming"
          title="重启中"
          aria-label="重启中"
        >
          <span className="task-state-resuming-icon" aria-hidden="true">
            <span />
          </span>
        </span>
      );
    }
    if (status === "queued") {
      return (
        <span
          className="task-state-pill task-state-pill-icon task-state-pill-waiting"
          title="等待中"
          aria-label="等待中"
        >
          <span className="task-state-waiting" aria-hidden="true">
            <span />
            <span />
            <span />
          </span>
        </span>
      );
    }
    if (status === "completed") {
      return (
        <span
          className="task-state-pill task-state-pill-icon task-state-pill-complete"
          title="已完成"
          aria-label="已完成"
        >
          <span className="task-state-complete-icon" aria-hidden="true">
            ✓
          </span>
        </span>
      );
    }
    if (status === "failed") {
      return (
        <span
          className="task-state-pill task-state-pill-icon task-state-pill-failed"
          title="失败"
          aria-label="失败"
        >
          <span className="task-state-failed-icon" aria-hidden="true">
            ×
          </span>
        </span>
      );
    }
    if (status === "paused") {
      return (
        <span
          className="task-state-pill task-state-pill-icon task-state-pill-paused"
          title="已暂停"
          aria-label="已暂停"
        >
          <span className="task-state-paused-icon" aria-hidden="true">
            ⏸
          </span>
        </span>
      );
    }
    if (status === "cancelled") {
      return (
        <span
          className="task-state-pill task-state-pill-icon task-state-pill-cancelled"
          title="已取消"
          aria-label="已取消"
        >
          <span className="task-state-cancelled-icon" aria-hidden="true">
            ○
          </span>
        </span>
      );
    }
    return <span className="task-state-pill">{getStatusLabel(status)}</span>;
  }

  function renderQueuedInlineLabel() {
    return (
      <span className="task-status-inline" aria-label="等待中">
        <span>等待中</span>
        <span className="task-state-waiting" aria-hidden="true">
          <span />
          <span />
          <span />
        </span>
      </span>
    );
  }

  const activeTask = useMemo(
    () => tasks.find((task) => task.id === activeTaskId) ?? null,
    [tasks, activeTaskId]
  );
  const activeDraft = activeTask ? editorDrafts[activeTask.id] ?? activeTask.markdown : "";
  const activeTitleDraft = activeTask ? titleDrafts[activeTask.id] ?? activeTask.title : "";
  const activeTitleTrimmed = activeTitleDraft.trim();
  const isTitleDirty = Boolean(
    activeTask && activeTitleTrimmed && activeTitleTrimmed !== activeTask.title
  );

  return (
    <AppFrame className="home-viewport">
      <ModelDownloadModal />
      <PageContainer className="py-4">
        <header className="saas-header-floating">
          <div className="saas-header-left">
            <h1 className="saas-header-title">MeetingNote</h1>
          </div>
        </header>

        <div className="saas-shell">
          <aside className="saas-sidebar">
            <div className="saas-sidebar-head">
              <h2 className="panel-title">历史任务</h2>
            </div>

            <div className="saas-history-list">
              <button
                className="saas-history-item saas-history-item-create"
                onClick={() => fileInputRef.current?.click()}
                type="button"
                aria-label="新建任务"
                title="新建任务"
              >
                <span className="saas-history-plus" aria-hidden="true">
                  +
                </span>
              </button>

              {tasks.map((task) => (
                <button
                  key={task.id}
                  className={`saas-history-item task-status-${task.status} ${
                    activeTaskId === task.id ? "saas-history-item-active" : ""
                  }`}
                  onClick={() => setActiveTaskId(task.id)}
                  type="button"
                >
                  <div className="saas-history-row">
                    <span className="saas-history-main">{task.title}</span>
                    {renderStatusIndicator(task.status)}
                  </div>
                  <div className="saas-history-row saas-history-row-meta">
                    <span>
                      {task.status === "completed"
                        ? `创建于 ${new Date(task.createdAt).toLocaleString()}`
                        : task.status === "queued"
                          ? renderQueuedInlineLabel()
                          : task.statusText}
                    </span>
                    <span>{task.progress}%</span>
                  </div>
                </button>
              ))}
            </div>
          </aside>

          <section className="saas-main">
            {activeTask ? (
              <>
                <header className="ds-section-heading-compact">
                  <div className="ds-section-copy">
                    <p className="ds-eyebrow">{getStatusLabel(activeTask.status)}</p>
                    <input
                      className="ds-title-inline-input ds-title-inline-input-compact"
                      value={activeTitleDraft}
                      aria-label="任务标题"
                      disabled={savingTitleTaskId === activeTask.id}
                      onChange={(e) =>
                        setTitleDrafts((current) => ({
                          ...current,
                          [activeTask.id]: e.target.value,
                        }))
                      }
                      onKeyDown={async (e) => {
                        if (e.key !== "Enter") return;
                        e.preventDefault();
                        await saveTaskTitle(activeTask, activeTitleDraft);
                      }}
                    />
                    <p className="ds-section-description">
                      {`${activeTask.fileName} · 创建于 ${new Date(activeTask.createdAt).toLocaleString()}`}
                    </p>
                  </div>
                  <div className="ds-section-actions task-actions-bar">
                    {isTitleDirty ? (
                      <Button
                        tone="secondary"
                        size="sm"
                        disabled={savingTitleTaskId === activeTask.id}
                        onClick={async () => {
                          await saveTaskTitle(activeTask, activeTitleDraft);
                        }}
                      >
                        {savingTitleTaskId === activeTask.id ? "保存中..." : "保存 ↵"}
                      </Button>
                    ) : null}

                    {/* Task control actions – context-dependent */}
                    {(activeTask.status === "processing" || activeTask.status === "pausing") && (
                      <>
                        <Button
                          tone="secondary"
                          size="sm"
                          disabled={actionLoading === activeTask.id || activeTask.status === "pausing"}
                          onClick={async () => {
                            setActionLoading(activeTask.id);
                            try {
                              applyTaskOptimisticUpdate(activeTask.id, (task) => ({
                                ...task,
                                status: "pausing",
                                statusText: "暂停中，将在当前片段处理完成后停止",
                                updatedAt: new Date().toISOString(),
                              }));
                              await pauseTask(activeTask.id);
                              startPolling(activeTask.id, activeTask.id);
                            } catch {
                              void syncTasksFromApi();
                            } finally {
                              setActionLoading(null);
                            }
                          }}
                        >
                          <TaskActionIcon kind="pause" />
                          <span>{activeTask.status === "pausing" ? "暂停中..." : "暂停"}</span>
                        </Button>
                        <Button
                          tone="ghost"
                          size="sm"
                          disabled={actionLoading === activeTask.id || activeTask.status === "pausing"}
                          onClick={async () => {
                            setActionLoading(activeTask.id);
                            try {
                              applyTaskOptimisticUpdate(activeTask.id, (task) => ({
                                ...task,
                                status: "cancelled",
                                progress: 0,
                                statusText:
                                  task.status === "pausing" ? "正在取消暂停中的任务..." : "正在取消...",
                                updatedAt: new Date().toISOString(),
                              }));
                              stopPolling(activeTask.id);
                              await cancelTask(activeTask.id);
                              void syncTasksFromApi();
                            } catch {
                              void syncTasksFromApi();
                            } finally {
                              setActionLoading(null);
                            }
                          }}
                        >
                          <TaskActionIcon kind="cancel" />
                          <span>取消</span>
                        </Button>
                      </>
                    )}
                    {(activeTask.status === "queued" || activeTask.status === "resuming") && (
                      <Button
                        tone="ghost"
                        size="sm"
                        disabled={actionLoading === activeTask.id || activeTask.status === "resuming"}
                        onClick={async () => {
                          setActionLoading(activeTask.id);
                          try {
                            applyTaskOptimisticUpdate(activeTask.id, (task) => ({
                              ...task,
                              status: "cancelled",
                              progress: 0,
                              statusText: task.status === "resuming" ? "正在取消重启中的任务..." : "正在取消...",
                              updatedAt: new Date().toISOString(),
                            }));
                            stopPolling(activeTask.id);
                            await cancelTask(activeTask.id);
                            void syncTasksFromApi();
                          } catch {
                            void syncTasksFromApi();
                          } finally {
                            setActionLoading(null);
                          }
                        }}
                      >
                        <TaskActionIcon kind="cancel" />
                        <span>取消</span>
                      </Button>
                    )}
                    {activeTask.status === "paused" && (
                      <>
                        <Button
                          tone="secondary"
                          size="sm"
                          disabled={actionLoading === activeTask.id}
                          onClick={async () => {
                            setActionLoading(activeTask.id);
                            try {
                              applyTaskOptimisticUpdate(activeTask.id, (task) => ({
                                ...task,
                                status: "resuming",
                                progress: 0,
                                statusText: "重启中，正在恢复任务处理",
                                updatedAt: new Date().toISOString(),
                              }));
                              await resumeTask(activeTask.id);
                              startPolling(activeTask.id, activeTask.id);
                              void syncTasksFromApi();
                            } catch {
                              void syncTasksFromApi();
                            } finally {
                              setActionLoading(null);
                            }
                          }}
                        >
                          <TaskActionIcon kind="resume" />
                          <span>继续</span>
                        </Button>
                        <Button
                          tone="ghost"
                          size="sm"
                          disabled={actionLoading === activeTask.id}
                          onClick={async () => {
                            setActionLoading(activeTask.id);
                            try {
                              applyTaskOptimisticUpdate(activeTask.id, (task) => ({
                                ...task,
                                status: "cancelled",
                                progress: 0,
                                statusText: "正在取消...",
                                updatedAt: new Date().toISOString(),
                              }));
                              stopPolling(activeTask.id);
                              await cancelTask(activeTask.id);
                              void syncTasksFromApi();
                            } catch {
                              void syncTasksFromApi();
                            } finally {
                              setActionLoading(null);
                            }
                          }}
                        >
                          <TaskActionIcon kind="cancel" />
                          <span>取消</span>
                        </Button>
                      </>
                    )}
                    {activeTask.status === "failed" && (
                      <Button
                        tone="secondary"
                        size="sm"
                        disabled={actionLoading === activeTask.id}
                        onClick={async () => {
                          setActionLoading(activeTask.id);
                          try {
                            autoRetryRef.current.delete(activeTask.id);
                            applyTaskOptimisticUpdate(activeTask.id, (task) => ({
                              ...task,
                              status: "queued",
                              progress: 0,
                              error: undefined,
                              statusText: "正在重新排队...",
                              updatedAt: new Date().toISOString(),
                            }));
                            await resumeTask(activeTask.id);
                            startPolling(activeTask.id, activeTask.id);
                            void syncTasksFromApi();
                          } catch {
                            void syncTasksFromApi();
                          } finally {
                            setActionLoading(null);
                          }
                        }}
                      >
                        <TaskActionIcon kind="retry" />
                        <span>重试</span>
                      </Button>
                    )}
                    {activeTask.status === "cancelled" && (
                      <Button
                        tone="secondary"
                        size="sm"
                        disabled={actionLoading === activeTask.id}
                        onClick={async () => {
                          setActionLoading(activeTask.id);
                          try {
                            autoRetryRef.current.delete(activeTask.id);
                            applyTaskOptimisticUpdate(activeTask.id, (task) => ({
                              ...task,
                              status: "queued",
                              progress: 0,
                              error: undefined,
                              statusText: "正在重新开始...",
                              updatedAt: new Date().toISOString(),
                            }));
                            await resumeTask(activeTask.id);
                            startPolling(activeTask.id, activeTask.id);
                            void syncTasksFromApi();
                          } catch {
                            void syncTasksFromApi();
                          } finally {
                            setActionLoading(null);
                          }
                        }}
                      >
                        <TaskActionIcon kind="retry" />
                        <span>重新开始</span>
                      </Button>
                    )}

                    <span className="task-state-pill">{activeTask.progress}%</span>
                  </div>
                </header>

                <div className="result-grid result-grid-single mt-6">
                  <section className="saas-section saas-section-editor">
                    <div className="panel-header">
                      <div>
                        <h2 className="panel-title">转录文本</h2>
                      </div>
                      <Button
                        tone="primary"
                        size="sm"
                        onClick={() => exportTextWithoutTimestamps(activeDraft, activeTask.fileName)}
                        disabled={!stripTimestamps(activeDraft).trim()}
                      >
                        导出文本
                      </Button>
                    </div>
                    <textarea
                      className="editor-area"
                      value={activeDraft}
                      placeholder="任务处理中，完成后这里会显示转录文本。"
                      onChange={(e) => {
                        const nextMarkdown = e.target.value;
                        setEditorDrafts((current) => ({
                          ...current,
                          [activeTask.id]: nextMarkdown,
                        }));
                      }}
                      onBlur={async () => {
                        const nextMarkdown = activeDraft;
                        if (nextMarkdown === activeTask.markdown) return;
                        try {
                          const updatedTask = await updateTaskMarkdown(activeTask.id, nextMarkdown);
                          setTasks((current) =>
                            sortTasks(
                              updateTaskCollection(current, activeTask.id, (task) => ({
                                ...task,
                                ...updatedTask,
                              }))
                            )
                          );
                          setEditorDrafts((current) => {
                            const next = { ...current };
                            delete next[activeTask.id];
                            return next;
                          });
                        } catch {
                          setEditorDrafts((current) => ({
                            ...current,
                            [activeTask.id]: activeTask.markdown,
                          }));
                        }
                      }}
                    />
                  </section>
                </div>
              </>
            ) : (
              <section className="saas-section result-empty">
                <h2 className="result-title">暂无任务</h2>
                <p className="result-subtitle">从左侧列表第一项新建任务并上传音频。</p>
              </section>
            )}
          </section>

          <input
            ref={fileInputRef}
            type="file"
            accept="audio/*"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) {
                enqueueFile(file);
              }
              e.currentTarget.value = "";
            }}
          />
        </div>
      </PageContainer>
    </AppFrame>
  );
}
