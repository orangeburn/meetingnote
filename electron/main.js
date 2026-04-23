const { app, BrowserWindow } = require("electron");
const { spawn, spawnSync } = require("child_process");
const fs = require("fs");
const http = require("http");
const path = require("path");

let mainWindow;
let asrProcess;
const ASR_PORT = 8765;
const ASR_HEALTH_URL = `http://127.0.0.1:${ASR_PORT}/health`;
const APP_URL = "http://localhost:3000";

function getAppRootDir() {
  // In packaged apps, extraResources are placed under process.resourcesPath.
  // In dev, __dirname is electron/ so we go one level up to the repo root.
  return app.isPackaged ? process.resourcesPath : path.join(__dirname, "..");
}

function getAsrLogPaths() {
  const logDir = app.getPath("userData");
  return {
    stdout: path.join(logDir, "asr-server.log"),
    stderr: path.join(logDir, "asr-server.err.log")
  };
}

function getVendoredFfmpegPaths() {
  const ffmpegDir = path.join(getAppRootDir(), "services", "asr_server", "vendor", "ffmpeg", "win32");
  return {
    dir: ffmpegDir,
    ffmpeg: path.join(ffmpegDir, "ffmpeg.exe"),
    ffprobe: path.join(ffmpegDir, "ffprobe.exe")
  };
}

function resolvePythonInvoker() {
  if (process.platform !== "win32") return { cmd: "python", prefixArgs: [] };

  // Static candidate list for common Python installations
  const candidates = [
    path.join(process.env.ProgramFiles || "C:\\Program Files", "Python310", "pythonw.exe"),
    path.join(process.env.ProgramFiles || "C:\\Program Files", "Python311", "pythonw.exe"),
    path.join(process.env.ProgramFiles || "C:\\Program Files", "Python312", "pythonw.exe"),
    path.join(process.env.ProgramFiles || "C:\\Program Files", "Python313", "pythonw.exe"),
    path.join(process.env.LOCALAPPDATA || "", "Programs", "Python", "Python310", "pythonw.exe"),
    path.join(process.env.LOCALAPPDATA || "", "Programs", "Python", "Python311", "pythonw.exe"),
    path.join(process.env.LOCALAPPDATA || "", "Programs", "Python", "Python312", "pythonw.exe"),
    path.join(process.env.LOCALAPPDATA || "", "Programs", "Python", "Python313", "pythonw.exe")
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (candidate && fs.existsSync(candidate)) {
      return { cmd: candidate, prefixArgs: [] };
    }
  }

  // Dynamic lookup: find python.exe via `where`, then check for pythonw.exe alongside it
  try {
    const result = spawnSync("where", ["python"], {
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
      timeout: 5000,
    });
    const firstLine = (result.stdout || "").toString().split(/\r?\n/)[0]?.trim();
    if (firstLine && firstLine.toLowerCase().endsWith("python.exe")) {
      const pythonwPath = firstLine.replace(/python\.exe$/i, "pythonw.exe");
      if (fs.existsSync(pythonwPath)) {
        return { cmd: pythonwPath, prefixArgs: [] };
      }
    }
  } catch (_) {
    // Ignore – fall through to python.exe fallback
  }

  // Fallback: use python.exe; windowsHide in spawn options still prevents console flash
  return { cmd: "python", prefixArgs: [] };
}

function logSpawnSyncResult(prefix, result) {
  const stdout = (result.stdout || "").toString();
  const stderr = (result.stderr || "").toString();
  for (const line of stdout.split(/\r?\n/)) {
    if (line.trim()) console.log(`${prefix} ${line}`);
  }
  for (const line of stderr.split(/\r?\n/)) {
    if (line.trim()) console.error(`${prefix}[ERR] ${line}`);
  }
}

function pipePrefixedStream(stream, prefix) {
  if (!stream) return;
  stream.on("data", (chunk) => {
    const text = chunk.toString();
    for (const line of text.split(/\r?\n/)) {
      if (line.trim()) {
        console.log(`${prefix} ${line}`);
      }
    }
  });
}

function waitForAsrHealth(timeoutMs = 1500) {
  return new Promise((resolve) => {
    const req = http.get(ASR_HEALTH_URL, (res) => {
      const ok = res.statusCode && res.statusCode >= 200 && res.statusCode < 300;
      res.resume();
      resolve(Boolean(ok));
    });
    req.setTimeout(timeoutMs, () => {
      req.destroy();
      resolve(false);
    });
    req.on("error", () => resolve(false));
  });
}

function waitForUrl(url, timeoutMs = 800) {
  return new Promise((resolve) => {
    const req = http.get(url, (res) => {
      const ok = res.statusCode && res.statusCode >= 200 && res.statusCode < 500;
      res.resume();
      resolve(Boolean(ok));
    });
    req.setTimeout(timeoutMs, () => {
      req.destroy();
      resolve(false);
    });
    req.on("error", () => resolve(false));
  });
}

function buildSplashHtml() {
  return `<!doctype html>
  <html lang="zh-CN">
    <head>
      <meta charset="UTF-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1.0" />
      <title>MeetingNote</title>
      <style>
        :root {
          color-scheme: light;
          --bg: #f5f7fb;
          --panel: rgba(255,255,255,0.88);
          --line: rgba(61, 78, 99, 0.12);
          --text: #17212b;
          --muted: #607086;
          --brand: #2f6fed;
        }
        * { box-sizing: border-box; }
        body {
          margin: 0;
          min-height: 100vh;
          display: grid;
          place-items: center;
          background:
            radial-gradient(circle at top left, rgba(47,111,237,0.12), transparent 32%),
            radial-gradient(circle at bottom right, rgba(36,167,127,0.1), transparent 28%),
            var(--bg);
          font-family: "Segoe UI", "PingFang SC", sans-serif;
          color: var(--text);
        }
        .shell {
          width: min(560px, calc(100vw - 48px));
          border: 1px solid var(--line);
          border-radius: 20px;
          background: var(--panel);
          backdrop-filter: blur(14px);
          box-shadow: 0 20px 60px rgba(23, 33, 43, 0.12);
          padding: 28px;
        }
        .eyebrow {
          margin: 0 0 8px;
          font-size: 12px;
          letter-spacing: 0.12em;
          text-transform: uppercase;
          color: var(--muted);
        }
        h1 {
          margin: 0;
          font-size: 32px;
          font-weight: 700;
        }
        p {
          margin: 12px 0 0;
          color: var(--muted);
          line-height: 1.7;
          font-size: 14px;
        }
        .row {
          margin-top: 20px;
          display: flex;
          align-items: center;
          gap: 12px;
        }
        .spinner {
          width: 18px;
          height: 18px;
          border-radius: 999px;
          border: 2px solid rgba(47,111,237,0.18);
          border-top-color: var(--brand);
          animation: spin 0.9s linear infinite;
        }
        .bar {
          margin-top: 18px;
          height: 6px;
          overflow: hidden;
          border-radius: 999px;
          background: rgba(47,111,237,0.08);
        }
        .bar > span {
          display: block;
          width: 34%;
          height: 100%;
          border-radius: inherit;
          background: linear-gradient(90deg, rgba(47,111,237,0.18), rgba(47,111,237,0.84));
          animation: slide 1.5s ease-in-out infinite;
        }
        @keyframes spin { to { transform: rotate(360deg); } }
        @keyframes slide {
          0% { transform: translateX(-110%); }
          100% { transform: translateX(310%); }
        }
      </style>
    </head>
    <body>
      <main class="shell">
        <p class="eyebrow">MeetingNote</p>
        <h1>正在启动应用</h1>
        <p>正在载入应用界面与本地数据，请稍等片刻。</p>
        <div class="row">
          <div class="spinner" aria-hidden="true"></div>
          <strong>正在连接前端页面…</strong>
        </div>
        <div class="bar"><span></span></div>
      </main>
    </body>
  </html>`;
}

async function startAsrServer() {
  const alreadyRunning = await waitForAsrHealth();
  if (alreadyRunning) {
    console.log(`[ASR] Reusing existing ASR server on ${ASR_HEALTH_URL}`);
    return;
  }

  const scriptPath = path.join(getAppRootDir(), "services", "asr_server", "server.py");
  const invoker = resolvePythonInvoker();
  const logPaths = getAsrLogPaths();
  const ffmpegPaths = getVendoredFfmpegPaths();
  const stdoutFd = fs.openSync(logPaths.stdout, "a");
  const stderrFd = fs.openSync(logPaths.stderr, "a");
  console.log(`[ASR] Launching server with: ${invoker.cmd} ${(invoker.prefixArgs || []).join(" ")}`.trim());
  console.log(`[ASR] Logs: ${logPaths.stdout}`);
  console.log(`[ASR] ffmpeg: ${ffmpegPaths.ffmpeg}`);
  asrProcess = spawn(invoker.cmd, [...invoker.prefixArgs, scriptPath], {
    stdio: ["ignore", stdoutFd, stderrFd],
    shell: false,
    windowsHide: true,
    detached: false,
    env: {
      ...process.env,
      MEETINGNOTE_FFMPEG_BIN: ffmpegPaths.ffmpeg,
      MEETINGNOTE_FFPROBE_BIN: ffmpegPaths.ffprobe,
      PATH: `${ffmpegPaths.dir}${path.delimiter}${process.env.PATH || ""}`
    }
  });

  asrProcess.on("error", (error) => {
    console.error("[ASR] Failed to start ASR server:", error);
  });

  asrProcess.on("close", (code) => {
    console.log(`ASR server exited with code ${code}`);
    asrProcess = null;
  });
}

/**
 * Synchronously kill the ASR Python process tree.
 * Uses spawnSync to guarantee the process is terminated before Electron exits.
 */
function killAsrProcess() {
  if (!asrProcess) return;
  const pid = asrProcess.pid;
  asrProcess = null; // Prevent double-kill from multiple quit events

  console.log(`[ASR] Killing ASR process tree (PID ${pid})...`);
  if (process.platform === "win32") {
    try {
      spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true,
      });
    } catch (e) {
      console.error("[ASR] taskkill failed:", e);
    }
  } else {
    try {
      process.kill(-pid, "SIGTERM");
    } catch (_) {
      // Process may already be dead
    }
  }
  console.log("[ASR] ASR process killed.");
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    backgroundColor: "#f5f7fb",
    show: true,
    webPreferences: {
      contextIsolation: true
    }
  });

  mainWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(buildSplashHtml())}`);
}

async function loadFrontendWhenReady() {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const ready = await waitForUrl(APP_URL, 800);
    if (ready) {
      await mainWindow?.loadURL(APP_URL);
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  console.error(`[APP] Frontend did not become ready at ${APP_URL}`);
  return false;
}

async function launchMainExperience() {
  const frontendReady = await loadFrontendWhenReady();
  if (!frontendReady) {
    return;
  }
  await startAsrServer();
}

app.whenReady().then(() => {
  createWindow();
  void launchMainExperience();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
      void launchMainExperience();
    }
  });
});

// Clean up ASR process on quit – use before-quit as primary, window-all-closed as fallback
app.on("before-quit", () => {
  killAsrProcess();
});

app.on("window-all-closed", () => {
  killAsrProcess();
  if (process.platform !== "darwin") {
    app.quit();
  }
});
