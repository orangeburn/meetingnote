import { useState, useEffect } from "react";
import axios from "axios";

export interface ModelStatus {
  needsDownload: boolean;
  isDownloading: boolean;
  downloadedBytes: number;
  error: string | null;
}

const API_BASE = "http://127.0.0.1:8765";

export function useModelCheck(): ModelStatus {
  const [status, setStatus] = useState<ModelStatus>({
    needsDownload: false,
    isDownloading: false,
    downloadedBytes: 0,
    error: null,
  });

  useEffect(() => {
    let pollingInterval: ReturnType<typeof setInterval> | null = null;
    let isCancelled = false;

    const pollStatus = async () => {
      try {
        const res = await axios.get(`${API_BASE}/api/model/download_status`);
        if (isCancelled) return;
        
        const data = res.data;
        setStatus(prev => ({
          ...prev,
          isDownloading: data.is_downloading,
          downloadedBytes: data.downloaded_bytes || 0,
          needsDownload: !data.model_complete,
        }));

        if (data.model_complete && !data.is_downloading) {
          if (pollingInterval) {
            clearInterval(pollingInterval);
            pollingInterval = null;
          }
        }
      } catch (err: any) {
        if (!isCancelled) {
          setStatus(prev => ({ ...prev, error: err.message || "Failed to fetch download status" }));
        }
      }
    };

    const startDownload = async () => {
      try {
        await axios.post(`${API_BASE}/api/model/download`);
        if (isCancelled) return;
        setStatus(prev => ({ ...prev, isDownloading: true, error: null }));
        pollingInterval = setInterval(pollStatus, 1000);
      } catch (err: any) {
        if (!isCancelled) {
          setStatus(prev => ({ ...prev, error: err.message || "Failed to start download" }));
        }
      }
    };

    const checkHealth = async () => {
      try {
        const res = await axios.get(`${API_BASE}/health`);
        if (isCancelled) return;
        
        const data = res.data;
        if (!data.model_complete) {
          setStatus(prev => ({ ...prev, needsDownload: true }));
          startDownload();
        } else {
          setStatus(prev => ({ ...prev, needsDownload: false, isDownloading: false }));
        }
      } catch (err: any) {
        if (!isCancelled) {
          setStatus(prev => ({ ...prev, error: err.message || "Backend offline" }));
        }
      }
    };

    checkHealth();

    return () => {
      isCancelled = true;
      if (pollingInterval) {
        clearInterval(pollingInterval);
      }
    };
  }, []);

  return status;
}
