import { app, BrowserWindow, shell } from "electron";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { registerProjectHandlers } from "./project/handlers";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const isDev = !!process.env.ELECTRON_RENDERER_URL;

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1480,
    height: 920,
    minWidth: 960,
    minHeight: 600,
    show: false,
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 14, y: 14 },
    backgroundColor: "#0B0F1A",
    webPreferences: {
      preload: join(__dirname, "../preload/index.mjs"),
      sandbox: false,
      contextIsolation: true,
    },
  });

  win.on("ready-to-show", () => {
    win.show();
    if (isDev) win.webContents.openDevTools({ mode: "right" });
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });

  if (isDev && process.env.ELECTRON_RENDERER_URL) {
    win.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    // electron-vite emits the renderer to out/renderer/ with index.html at its root.
    win.loadFile(join(__dirname, "../renderer/index.html"));
  }
}

// Register project lifecycle IPC + chokidar watcher (STORY-018). The teardown
// callback is retained so `before-quit` can flush native watchers cleanly.
let teardownProjectHandlers: (() => Promise<void>) | null = null;

app.whenReady().then(() => {
  teardownProjectHandlers = registerProjectHandlers();
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => {
  const teardown = teardownProjectHandlers;
  teardownProjectHandlers = null;
  // Best-effort: closing chokidar watchers is async, but `before-quit` is
  // synchronous from Electron's perspective. We fire-and-forget; Electron
  // waits a tick before the process exits, which is enough for the close
  // promises to drain on macOS/Linux.
  if (teardown) void teardown();
});
