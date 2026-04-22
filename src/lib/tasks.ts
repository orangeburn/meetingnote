"use client";

export type Segment = {
  speaker: string;
  start_ms: number;
  end_ms: number;
  text: string;
};

export type JobStatus = "idle" | "uploading" | "queued" | "processing" | "completed" | "failed";

export type TranscriptionTask = {
  id: string;
  jobId: string | null;
  title: string;
  fileName: string;
  fileSize: number;
  createdAt: string;
  updatedAt: string;
  status: JobStatus;
  statusText: string;
  progress: number;
  segments: Segment[];
  markdown: string;
  error?: string;
};

const STORAGE_KEY = "meetingnote.tasks";
const API_BASE = "http://127.0.0.1:8765";

type ApiTask = {
  job_id: string;
  filename: string;
  status: JobStatus;
  progress: number;
  message: string;
  segments?: Segment[];
  markdown?: string;
  error?: string;
  created_at: string;
  updated_at?: string;
};

export function msToTime(ms: number): string {
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

export function renderMarkdown(segments: Segment[]): string {
  const lines: string[] = [];
  for (const seg of segments) {
    lines.push(`[${msToTime(seg.start_ms)} - ${msToTime(seg.end_ms)}] [${seg.speaker}]`);
    lines.push(seg.text || "");
    lines.push("");
  }
  return lines.join("\n");
}

export function formatFileSize(fileSize: number): string {
  if (fileSize < 1024 * 1024) {
    return `${Math.max(1, Math.round(fileSize / 1024))} KB`;
  }
  return `${(fileSize / 1024 / 1024).toFixed(1)} MB`;
}

export function loadTasks(): TranscriptionTask[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as TranscriptionTask[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function saveTasks(tasks: TranscriptionTask[]) {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(tasks));
}

export function createTaskFromFile(file: File): TranscriptionTask {
  const now = new Date().toISOString();
  const baseName = file.name.replace(/\.[^/.]+$/, "") || "未命名任务";
  return {
    id: `task-${Date.now()}`,
    jobId: null,
    title: baseName,
    fileName: file.name,
    fileSize: file.size,
    createdAt: now,
    updatedAt: now,
    status: "uploading",
    statusText: "上传中",
    progress: 0,
    segments: [],
    markdown: "",
  };
}

export function normalizeTask(task: TranscriptionTask): TranscriptionTask {
  const normalizedId = task.jobId || task.id;
  const baseName = task.title || task.fileName.replace(/\.[^/.]+$/, "") || "未命名任务";
  return {
    ...task,
    id: normalizedId,
    title: baseName,
  };
}

export function taskFromApi(task: ApiTask): TranscriptionTask {
  const fileName = task.filename || "未命名任务";
  return {
    id: task.job_id,
    jobId: task.job_id,
    title: fileName.replace(/\.[^/.]+$/, "") || "未命名任务",
    fileName,
    fileSize: 0,
    createdAt: task.created_at,
    updatedAt: task.updated_at || task.created_at,
    status: task.status,
    statusText: task.message || "处理中",
    progress: Number(task.progress || 0),
    segments: task.segments || [],
    markdown: task.markdown || "",
    error: task.error,
  };
}

export function mergeTaskSources(localTasks: TranscriptionTask[], apiTasks: TranscriptionTask[]) {
  const merged = new Map<string, TranscriptionTask>();

  for (const task of localTasks.map(normalizeTask)) {
    merged.set(task.jobId || task.id, task);
  }

  for (const task of apiTasks.map(normalizeTask)) {
    const key = task.jobId || task.id;
    const localTask = merged.get(key);
    merged.set(
      key,
      localTask
        ? {
            ...localTask,
            ...task,
            fileSize: localTask.fileSize || task.fileSize,
            markdown: localTask.markdown || task.markdown,
          }
        : task
    );
  }

  return sortTasks([...merged.values()]);
}

export async function fetchTasksFromApi(): Promise<TranscriptionTask[]> {
  const response = await fetch(`${API_BASE}/api/transcribe/jobs?limit=200`, { cache: "no-store" });
  if (!response.ok) {
    throw new Error(`Failed to fetch tasks: ${response.status}`);
  }
  const data = (await response.json()) as { jobs?: ApiTask[] };
  return (data.jobs || []).map(taskFromApi);
}

export async function fetchTaskById(taskId: string): Promise<TranscriptionTask | null> {
  const response = await fetch(`${API_BASE}/api/transcribe/jobs/${taskId}`, { cache: "no-store" });
  if (response.status === 404) return null;
  if (!response.ok) {
    throw new Error(`Failed to fetch task: ${response.status}`);
  }
  const data = (await response.json()) as ApiTask;
  return taskFromApi(data);
}

export function updateTaskCollection(
  tasks: TranscriptionTask[],
  taskId: string,
  updater: (task: TranscriptionTask) => TranscriptionTask
) {
  return tasks.map((task) => (task.id === taskId ? updater(task) : task));
}

export function sortTasks(tasks: TranscriptionTask[]) {
  return [...tasks].sort((a, b) => +new Date(b.updatedAt) - +new Date(a.updatedAt));
}
