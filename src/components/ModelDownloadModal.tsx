"use client";

import React from "react";
import { useModelCheck } from "../hooks/useModelCheck";

export function ModelDownloadModal() {
  const { needsDownload, isDownloading, downloadedBytes, error, isBackendOffline } = useModelCheck();
  const errorText = typeof error === "string" ? error : error ? String(error) : "";

  // 只有在后端在线且不需要下载时才隐藏
  if (!isBackendOffline && !needsDownload) {
    return null;
  }

  const downloadedMB = (downloadedBytes / 1024 / 1024).toFixed(2);

  return (
    <div className="model-status-banner">
      <div className="model-status-head">
        <div className="model-status-dot" />
        <h2 className="model-status-title">系统初始化</h2>
      </div>

      {isBackendOffline ? (
        <div className="mt-4">
          <p className="model-status-copy">正在连接后端 ASR 服务...</p>
          <div className="mt-4 flex items-center gap-3">
            <div className="model-spinner" />
            <p className="model-status-footnote">首页可以先继续查看任务，服务就绪后可直接上传。</p>
          </div>
        </div>
      ) : errorText ? (
        <div className="model-status-error mt-4">
          <strong>错误：</strong> {errorText}
          <div className="mt-2 text-xs text-red-500">
            {errorText.toLowerCase().includes("winerror") || errorText.toLowerCase().includes("dll") ? (
              <span>提示：系统底层模块加载失败，通常需要安装相关运行库。</span>
            ) : (
              <span>请检查本地网络是否正常连接 ModelScope。</span>
            )}
          </div>
        </div>
      ) : (
        <div className="mt-4">
          <p className="model-status-copy">
            正在准备语音模型，完成后可直接上传音频。
          </p>
          <div className="mt-4 flex flex-col gap-3">
            <div className="relative h-2 w-full overflow-hidden rounded-full bg-slate-100">
              <div className="absolute left-0 top-0 h-full w-1/3 animate-[slide_1.5s_ease-in-out_infinite] rounded-full bg-blue-600"></div>
            </div>

            <div className="text-sm font-medium text-slate-700">
              {isDownloading ? `正在下载模型... 已缓存 ${downloadedMB} MB` : "准备下载中..."}
            </div>
          </div>
        </div>
      )}

      {/* 可以在全局 css 加上此关键帧，或者用 tailwind arbitary values：*/}
      <style dangerouslySetInnerHTML={{__html: `
        @keyframes slide {
          0% { left: -33%; }
          100% { left: 100%; }
        }
      `}} />
    </div>
  );
}
