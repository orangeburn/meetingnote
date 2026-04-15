"use client";

import React from "react";
import { useModelCheck } from "../hooks/useModelCheck";

export function ModelDownloadModal() {
  const { needsDownload, isDownloading, downloadedBytes, error } = useModelCheck();

  if (!needsDownload) {
    return null;
  }

  const downloadedMB = (downloadedBytes / 1024 / 1024).toFixed(2);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm">
      <div className="mx-auto w-full max-w-md rounded-2xl bg-white p-6 shadow-2xl">
        <h2 className="text-xl font-bold text-slate-800">模型初始化</h2>
        
        {error ? (
          <div className="mt-4 rounded-xl bg-red-50 p-4 text-sm text-red-600">
            <strong>错误：</strong> {error}
            <div className="mt-2 text-xs text-red-500">
              请检查后端服务是否启动，或者本地网络是否正常连接 ModelScope。
            </div>
          </div>
        ) : (
          <div className="mt-4">
            <p className="text-sm text-slate-600">
              检测到本地未安装完整的语音识别大模型（Fun-ASR-Nano）。
              系统正在自动为您下载所需的模型文件。
            </p>
            
            <div className="mt-6 flex flex-col items-center justify-center space-y-3">
              <div className="relative h-2 w-full overflow-hidden rounded-full bg-slate-100">
                <div className="absolute left-0 top-0 h-full w-1/3 animate-[slide_1.5s_ease-in-out_infinite] rounded-full bg-blue-600"></div>
              </div>
              
              <div className="text-sm font-medium text-slate-700">
                {isDownloading ? `正在下载... 已缓存 ${downloadedMB} MB` : "准备下载中..."}
              </div>
            </div>
          </div>
        )}
      </div>
      
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
