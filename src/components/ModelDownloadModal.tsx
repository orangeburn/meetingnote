"use client";

import React from "react";
import { useModelCheck } from "../hooks/useModelCheck";

export function ModelDownloadModal() {
  const {
    isReady,
    needsDownload,
    isDownloading,
    isInitializing,
    downloadedBytes,
    error,
    isBackendOffline,
    hasChecked,
  } = useModelCheck();
  const errorText = typeof error === "string" ? error : error ? String(error) : "";

  // 首轮状态未确认前不展示，避免首屏闪现。
  if (!hasChecked) {
    return null;
  }

  // 只有模型真正可用后才隐藏；仅“文件已下载完成”仍要继续显示加载状态
  if (!isBackendOffline && isReady) {
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
            {needsDownload ? "准备下载语音模型（仅首次），完成后可直接上传。" : "正在初始化语音引擎，这可能需要一点时间。"}
          </p>
          <div className="mt-4 flex flex-col gap-3">
            <div className="relative h-2 w-full overflow-hidden rounded-full bg-slate-100">
              <div className="absolute left-0 top-0 h-full w-1/3 animate-[slide_1.5s_ease-in-out_infinite] rounded-full bg-blue-600"></div>
            </div>

            <div className="text-sm font-medium text-slate-700">
              {isDownloading
                ? `正在下载模型 (已缓存 ${downloadedMB} MB)...`
                : isInitializing
                  ? "正在载入模型到内存..."
                  : needsDownload
                    ? "等待下载..."
                    : "正在启动服务..."}
            </div>
          </div>
        </div>
      )}

      {/* 可以在全局 css 加上此关键帧，或者用 tailwind arbitary values：*/}
      <style dangerouslySetInnerHTML={{
        __html: `
        @keyframes slide {
          0% { left: -33%; }
          100% { left: 100%; }
        }
      `}} />
    </div>
  );
}
