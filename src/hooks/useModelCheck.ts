import { useState, useEffect, useRef } from "react";
import axios from "axios";

export interface ModelStatus {
  needsDownload: boolean;
  isDownloading: boolean;
  isInitializing: boolean;
  isReady: boolean;
  downloadedBytes: number;
  error: string | null;
  isBackendOffline: boolean;
  hasChecked: boolean;
}

const API_BASE = "http://127.0.0.1:8765";

export function useModelCheck(): ModelStatus {
  const hasRequestedDownload = useRef(false);
  const [status, setStatus] = useState<ModelStatus>({
    needsDownload: false,
    isDownloading: false,
    isInitializing: false,
    isReady: false,
    downloadedBytes: 0,
    error: null,
    isBackendOffline: true,
    hasChecked: false,
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
          isReady: Boolean(data.ready),
          isDownloading: data.is_downloading,
          isInitializing: data.initializing,
          downloadedBytes: data.downloaded_bytes || 0,
          needsDownload: !data.model_complete,
          isBackendOffline: false,
          hasChecked: true,
          error: data.last_error || null
        }));

        if (data.ready && !data.is_downloading && !data.initializing) {
          if (pollingInterval) {
            clearInterval(pollingInterval);
            pollingInterval = null;
          }
        }
      } catch (err: any) {
        if (!isCancelled) {
          setStatus(prev => ({ ...prev, isBackendOffline: true, hasChecked: true }));
        }
      }
    };

    const startModelPreparation = async () => {
      try {
        await axios.post(`${API_BASE}/api/model/download`);
        if (isCancelled) return;
        setStatus(prev => ({
          ...prev,
          isDownloading: prev.needsDownload,
          isInitializing: true,
          error: null,
        }));
        void pollStatus();
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

        const isReady = Boolean(data.ready);
        const needsDownload = !data.model_complete;
        const isInitializing = Boolean(data.initializing);
        const isDownloading = Boolean(data.is_downloading);
        const needsPreparation = !isReady;

        if (needsPreparation) {
          setStatus(prev => ({ 
            ...prev, 
            isReady,
            needsDownload,
            isDownloading,
            isInitializing,
            isBackendOffline: false,
            hasChecked: true,
            error: data.last_error || null 
          }));

          if (!isDownloading && !isInitializing && !hasRequestedDownload.current) {
            hasRequestedDownload.current = true;
            startModelPreparation();
          }
        } else {
          hasRequestedDownload.current = false;
          setStatus(prev => ({ 
            ...prev, 
            isReady: true,
            needsDownload: false,
            isDownloading: false,
            isInitializing: false,
            isBackendOffline: false,
            hasChecked: true,
            error: null 
          }));
        }
      } catch (err: any) {
        if (!isCancelled) {
          setStatus(prev => ({ ...prev, isBackendOffline: true, hasChecked: true }));
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
