"use client";

export default function GlobalError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <main className="min-h-screen bg-slate-50 p-6">
      <div className="mx-auto max-w-3xl rounded-xl border border-rose-200 bg-white p-6 shadow">
        <h1 className="text-xl font-bold text-rose-700">页面发生错误</h1>
        <p className="mt-2 text-sm text-slate-600">应用已捕获到前端异常，避免出现白屏。你可以点击重试，或把下方错误信息发给我继续排查。</p>
        <pre className="mt-4 overflow-auto rounded bg-slate-900 p-3 text-xs text-slate-100">
          {error?.message || "Unknown frontend error"}
        </pre>
        <button onClick={reset} className="mt-4 rounded bg-slate-900 px-4 py-2 text-white">
          重试
        </button>
      </div>
    </main>
  );
}
