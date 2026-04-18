import { useState, useEffect, useRef } from "react";
import axios from "axios";

export interface ModelStatus {
  needsDownload: boolean;
  isDownloading: boolean;
  downloadedBytes: number;
  error: string | null;
  isBackendOffline: boolean;
}

const API_BASE = "http://127.0.0.1:8765";

export function useModelCheck(): ModelStatus {
  const hasRequestedDownload = useRef(false);
  const [status, setStatus] = useState<ModelStatus>({
    needsDownload: false,
    isDownloading: false,
    downloadedBytes: 0,
    error: null,
    isBackendOffline: true,
  });

  useEffect(() => {
    let pollingInterval: ReturnType<typeof setInterval> | null = null;
    let healthRetryInterval: ReturnType<typeof setInterval> | null = null;
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
          isBackendOffline: false,
          error: data.last_error || null
        }));

        if (data.model_complete && !data.is_downloading) {
          if (pollingInterval) {
            clearInterval(pollingInterval);
            pollingInterval = null;
          }
        }
      } catch (err: any) {
        if (!isCancelled) {
          setStatus(prev => ({ ...prev, isBackendOffline: true }));
        }
      }
    };

    const startDownload = async () => {
      try {
        await axios.post(`${API_BASE}/api/model/download`);
        if (isCancelled) return;
        setStatus(prev => ({ ...prev, isDownloading: true, error: null }));
        if (pollingInterval) clearInterval(pollingInterval);
        pollingInterval = setInterval(pollStatus, 2000);
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
        if (healthRetryInterval) {
          clearInterval(healthRetryInterval);
          healthRetryInterval = null;
        }

        if (!data.model_complete) {
          setStatus(prev => ({ 
            ...prev, 
            needsDownload: true, 
            isBackendOffline: false,
            error: data.last_error || null 
          }));
          // If model is incomplete, proactively request download once.
          // This avoids getting stuck when backend reports a non-fatal pre-download message.
          if (!data.is_downloading && !hasRequestedDownload.current) {
            hasRequestedDownload.current = true;
            startDownload();
          }
        } else {
          hasRequestedDownload.current = false;
          setStatus(prev => ({ 
            ...prev, 
            needsDownload: false, 
            isDownloading: false, 
            isBackendOffline: false,
            error: null 
          }));
        }
      } catch (err: any) {
        if (!isCancelled) {
          setStatus(prev => ({ ...prev, isBackendOffline: true }));
        }
      }
    };

    // Keep trying to connect until backend is up
    checkHealth();
    healthRetryInterval = setInterval(checkHealth, 2000);

    return () => {
      isCancelled = true;
      if (pollingInterval) clearInterval(pollingInterval);
      if (healthRetryInterval) clearInterval(healthRetryInterval);
    };
  }, []);

  return status;
}
