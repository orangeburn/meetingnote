const { app, BrowserWindow } = require("electron");
const { spawn } = require("child_process");
const path = require("path");

let mainWindow;
let asrProcess;

function startAsrServer() {
  const scriptPath = path.join(__dirname, "..", "services", "asr_server", "server.py");
  asrProcess = spawn("python", [scriptPath], {
    stdio: "inherit",
    shell: false
  });

  asrProcess.on("close", (code) => {
    console.log(`ASR server exited with code ${code}`);
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
  startAsrServer();
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on("window-all-closed", () => {
  if (asrProcess) {
    asrProcess.kill();
  }
  if (process.platform !== "darwin") {
    app.quit();
  }
});
