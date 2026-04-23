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
  type JobStatus,
  type Segment,
  type TranscriptionTask,
} from "@/lib/tasks";

const API_BASE = "http://127.0.0.1:8765";

export default function HomePage() {
  const [tasks, setTasks] = useState<TranscriptionTask[]>([]);
  const [activeTaskId, setActiveTaskId] = useState<string | null>(null);
  const pollingRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const activeTaskIdRef = useRef<string | null>(null);
  const manualPollingRef = useRef(false);
  const queuedFilesRef = useRef<File[]>([]);
  const processingQueueRef = useRef(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [editorDrafts, setEditorDrafts] = useState<Record<string, string>>({});
  const [titleDrafts, setTitleDrafts] = useState<Record<string, string>>({});
  const [savingTitleTaskId, setSavingTitleTaskId] = useState<string | null>(null);

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
      setTasks(sortTasks(apiTasks.map(normalizeTask)));
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
    const resumableTask = tasks.find(
      (task) =>
        task.jobId &&
        (task.status === "uploading" || task.status === "queued" || task.status === "processing")
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
      if (pollingRef.current && activeTaskIdRef.current === resumableTask.id) {
        clearInterval(pollingRef.current);
        pollingRef.current = null;
        activeTaskIdRef.current = null;
      }
    };
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
      if (pollingRef.current) {
        clearInterval(pollingRef.current);
      }
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
      if (pollingRef.current) {
        clearInterval(pollingRef.current);
        pollingRef.current = null;
      }
      activeTaskIdRef.current = null;
      return "failed";
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
      setTasks((current) => {
        const taskIndex = current.findIndex((task) => task.id === nextTask.id);
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
        if (status === "completed" || status === "failed") {
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 800));
      }
      manualPollingRef.current = false;
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
      manualPollingRef.current = false;
    }
  }

  async function processFileQueue() {
    if (processingQueueRef.current) return;
    processingQueueRef.current = true;
    try {
      while (queuedFilesRef.current.length > 0) {
        const nextFile = queuedFilesRef.current.shift();
        if (!nextFile) break;
        await transcribeFile(nextFile);
      }
    } finally {
      processingQueueRef.current = false;
    }
  }

  function enqueueFile(file: File) {
    queuedFilesRef.current.push(file);
    void processFileQueue();
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
    if (status === "queued") return "等待中";
    if (status === "completed") return "已完成";
    if (status === "failed") return "失败";
    return "待开始";
  }

  function renderStatusIndicator(status: JobStatus) {
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
    return <span className="task-state-pill">{getStatusLabel(status)}</span>;
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
            <h1 className="saas-header-title">转录控制台</h1>
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
                  <div className="ds-section-actions">
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
