import { renderHook, act } from "@testing-library/react";
import axios from "axios";
import { useModelCheck } from "../hooks/useModelCheck";

jest.mock("axios");
const mockedAxios = axios as jest.Mocked<typeof axios>;

describe("useModelCheck hook", () => {
  beforeEach(() => {
    jest.useFakeTimers();
    mockedAxios.get.mockClear();
    mockedAxios.post.mockClear();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it("should set needsDownload to true and start downloading if model is incomplete", async () => {
    // Mock health check returning incomplete model
    mockedAxios.get.mockImplementation((url) => {
      if (url.includes("/health")) {
        return Promise.resolve({ data: { model_complete: false } });
      }
      if (url.includes("/api/model/download_status")) {
        return Promise.resolve({ data: { is_downloading: true, downloaded_bytes: 1048576, model_complete: false } });
      }
      return Promise.reject(new Error("not found"));
    });

    mockedAxios.post.mockResolvedValue({ data: { ok: true, is_downloading: true } });

    const { result } = renderHook(() => useModelCheck());

    // Initially
    expect(result.current.needsDownload).toBe(false);

    // Allow effects to run
    await act(async () => {
      await Promise.resolve();
    });

    expect(mockedAxios.get).toHaveBeenCalledWith(expect.stringContaining("/health"));
    expect(mockedAxios.post).toHaveBeenCalledWith(expect.stringContaining("/api/model/download"));

    // Check status updated
    expect(result.current.needsDownload).toBe(true);
    expect(result.current.isDownloading).toBe(true);

    // Fast forward for polling
    await act(async () => {
      jest.advanceTimersByTime(1000);
      await Promise.resolve();
    });

    expect(mockedAxios.get).toHaveBeenCalledWith(expect.stringContaining("/api/model/download_status"));
    expect(result.current.downloadedBytes).toBe(1048576);
  });

  it("should not start download if model is complete initially", async () => {
    mockedAxios.get.mockResolvedValueOnce({ data: { model_complete: true } });

    const { result } = renderHook(() => useModelCheck());

    await act(async () => {
      await Promise.resolve();
    });

    expect(mockedAxios.get).toHaveBeenCalledWith(expect.stringContaining("/health"));
    expect(mockedAxios.post).not.toHaveBeenCalled();
    expect(result.current.needsDownload).toBe(false);
    expect(result.current.isDownloading).toBe(false);
  });
});
