"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { useParams } from "next/navigation";
import { ModelDownloadModal } from "@/components/ModelDownloadModal";
import { fetchTaskById, loadTasks, normalizeTask, saveTasks, type TranscriptionTask } from "@/lib/tasks";

function exportMd(markdown: string, fileName: string) {
  const blob = new Blob([markdown], { type: "text/markdown;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${fileName.replace(/\.[^/.]+$/, "") || "meeting-note"}.md`;
  a.click();
  URL.revokeObjectURL(url);
}

export default function TaskResultPage() {
  const params = useParams<{ id: string }>();
  const [tasks, setTasks] = useState<TranscriptionTask[]>([]);

  useEffect(() => {
    const localTasks = loadTasks().map(normalizeTask);
    setTasks(localTasks);

    void (async () => {
      try {
        const apiTask = await fetchTaskById(params.id);
        if (!apiTask) return;
        const nextTasks = localTasks.some((item) => item.id === apiTask.id)
          ? localTasks.map((item) => (item.id === apiTask.id ? { ...item, ...apiTask } : item))
          : [apiTask, ...localTasks];
        setTasks(nextTasks);
        saveTasks(nextTasks);
      } catch {
        setTasks(localTasks);
      }
    })();
  }, []);

  const task = useMemo(
    () => tasks.find((item) => item.id === params.id),
    [params.id, tasks]
  );

  if (!task) {
    return (
      <main className="meetingnote-shell min-h-screen">
        <ModelDownloadModal />
        <div className="mx-auto flex min-h-screen max-w-5xl items-center justify-center px-4 py-8">
          <section className="result-shell w-full max-w-2xl">
            <div className="result-topbar">
              <Link href="/" className="ghost-button">
                返回任务
              </Link>
            </div>
            <div className="result-empty">
              <h1 className="result-title">任务不存在</h1>
              <p className="result-subtitle">这个转录任务可能已经被清空，或者尚未写入本地列表。</p>
            </div>
          </section>
        </div>
      </main>
    );
  }

  return (
    <main className="meetingnote-shell result-page-frame">
      <ModelDownloadModal />
      <div className="result-page-body mx-auto w-full max-w-7xl px-4 py-6 sm:px-6 lg:px-10">
        <section className="result-shell result-shell-detail">
          <div className="result-topbar">
            <Link href="/" className="ghost-button">
              返回任务
            </Link>
          </div>

          <div className="result-header">
            <div>
              <p className="result-kicker">{task.statusText}</p>
              <h1 className="result-title">{task.title}</h1>
              <p className="result-subtitle">
                {task.fileName} · {new Date(task.updatedAt).toLocaleString()}
              </p>
            </div>
            <div className={`result-badge result-${task.status}`}>{task.progress}%</div>
          </div>

          <section className="result-grid">
            <div className="result-panel result-panel-editor">
              <div className="panel-header">
                <div>
                  <div className="panel-kicker">Markdown</div>
                  <h2 className="panel-title">文本</h2>
                </div>
                <button
                  className="primary-button"
                  onClick={() => exportMd(task.markdown, task.fileName)}
                  disabled={!task.markdown.trim()}
                >
                  导出 Markdown
                </button>
              </div>
              <textarea
                value={task.markdown}
                onChange={(e) => {
                  const nextTasks = tasks.map((item) =>
                    item.id === task.id
                      ? { ...item, markdown: e.target.value, updatedAt: new Date().toISOString() }
                      : item
                  );
                  setTasks(nextTasks);
                  saveTasks(nextTasks);
                }}
                className="editor-area"
                placeholder="这里会显示可编辑的 Markdown。"
              />
            </div>
          </section>
        </section>
      </div>
    </main>
  );
}
