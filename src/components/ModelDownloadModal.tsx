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
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm">
      <div className="mx-auto w-full max-w-md rounded-2xl bg-white p-6 shadow-2xl border border-blue-100">
        <div className="flex items-center gap-3">
          <div className="h-3 w-3 animate-pulse rounded-full bg-blue-500"></div>
          <h2 className="text-xl font-bold text-slate-800">系统初始化</h2>
        </div>
        
        {isBackendOffline ? (
          <div className="mt-4">
            <p className="text-sm text-slate-600">
              正在连接后端 ASR 服务...
            </p>
            <div className="mt-4 flex items-center justify-center">
              <div className="h-8 w-8 animate-spin rounded-full border-4 border-blue-200 border-t-blue-600"></div>
            </div>
            <p className="mt-4 text-[10px] text-slate-400 text-center">
              如果长时间未连接，请确认 Python 环境已正确安装并在后台运行。
            </p>
          </div>
        ) : errorText ? (
          <div className="mt-4 rounded-xl bg-red-50 p-4 text-sm text-red-600">
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
            <p className="text-sm text-slate-600">
              检测到本地未安装完整的语音识别大模型（Fun-ASR-Nano）。
              系统正在自动为您下载所需的模型文件。
            </p>
            
            {error ? (
              <div className="mt-4 rounded-xl bg-amber-50 p-4 border border-amber-200">
                <div className="flex items-start gap-2 text-amber-800">
                  <span className="text-lg">⚠️</span>
                  <div className="text-xs space-y-1">
                    <p className="font-bold">服务初始化异常：</p>
                    <p className="font-mono bg-amber-100/50 p-1 rounded break-all">{error}</p>
                    <p className="mt-2 text-[10px] opacity-80">
                      提示：如果是 [WinError 126] 错误，请尝试安装 
                      <a href="https://aka.ms/vs/17/release/vc_redist.x64.exe" className="underline font-bold ml-1" target="_blank">
                        Microsoft Visual C++ Redistributable
                      </a>
                    </p>
                  </div>
                </div>
              </div>
            ) : (
              <div className="mt-6 flex flex-col items-center justify-center space-y-3">
                <div className="relative h-2 w-full overflow-hidden rounded-full bg-slate-100">
                  <div className="absolute left-0 top-0 h-full w-1/3 animate-[slide_1.5s_ease-in-out_infinite] rounded-full bg-blue-600"></div>
                </div>
                
                <div className="text-sm font-medium text-slate-700">
                  {isDownloading ? `正在下载模型... 已缓存 ${downloadedMB} MB` : "准备下载中..."}
                </div>
              </div>
            )}
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
