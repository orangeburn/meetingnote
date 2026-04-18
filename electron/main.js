const { app, BrowserWindow } = require("electron");
const { spawn, spawnSync } = require("child_process");
const http = require("http");
const path = require("path");

let mainWindow;
let asrProcess;
const ASR_PORT = 8765;
const ASR_HEALTH_URL = `http://127.0.0.1:${ASR_PORT}/health`;

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

function ensureAsrPythonDeps() {
  const check = spawnSync(
    "python",
    ["-c", "import fastapi,uvicorn,funasr,modelscope,multipart"],
    { stdio: "pipe", shell: false, windowsHide: true }
  );

  if (check.status === 0) {
    console.log("[ASR] Python dependencies are ready.");
    return true;
  }

  console.log("[ASR] Missing Python dependencies. Installing from requirements...");
  const requirementsPath = path.join(__dirname, "..", "services", "asr_server", "requirements.txt");
  const install = spawnSync("python", ["-m", "pip", "install", "-r", requirementsPath], {
    stdio: "inherit",
    shell: false,
    windowsHide: true
  });

  if (install.status !== 0) {
    console.error("[ASR] Failed to install Python dependencies.");
    return false;
  }

  console.log("[ASR] Python dependencies installed.");
  return true;
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

async function startAsrServer() {
  const depsOk = ensureAsrPythonDeps();
  if (!depsOk) {
    console.error("[ASR] Skip starting ASR server because dependencies are unavailable.");
    return;
  }

  const alreadyRunning = await waitForAsrHealth();
  if (alreadyRunning) {
    console.log(`[ASR] Reusing existing ASR server on ${ASR_HEALTH_URL}`);
    return;
  }

  const scriptPath = path.join(__dirname, "..", "services", "asr_server", "server.py");
  asrProcess = spawn("python", [scriptPath], {
    stdio: ["ignore", "pipe", "pipe"],
    shell: false,
    windowsHide: true,
    detached: process.platform === "win32"
  });

  pipePrefixedStream(asrProcess.stdout, "[ASR]");
  pipePrefixedStream(asrProcess.stderr, "[ASR][ERR]");

  asrProcess.on("error", (error) => {
    console.error("[ASR] Failed to start ASR server:", error);
  });

  asrProcess.on("close", (code) => {
    console.log(`ASR server exited with code ${code}`);
    asrProcess = null;
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    webPreferences: {
      contextIsolation: true
    }
  });

  const devUrl = "http://localhost:3000";
  mainWindow.loadURL(devUrl);
}

app.whenReady().then(() => {
  void startAsrServer();
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on("window-all-closed", () => {
  if (asrProcess) {
    if (process.platform === "win32") {
      spawn("taskkill", ["/PID", String(asrProcess.pid), "/T", "/F"], {
        stdio: "ignore",
        shell: false,
        windowsHide: true
      });
    } else {
      asrProcess.kill();
    }
  }
  if (process.platform !== "darwin") {
    app.quit();
  }
});
