import {
  app,
  BrowserWindow,
  dialog,
  globalShortcut,
  ipcMain,
  Menu,
  nativeImage,
  screen,
  session,
  Tray,
} from "electron";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SwitchboardClient } from "../src/client.js";
import { ensureRuntimeHome, getRuntimeConfig } from "../src/config.js";
import { focusSession } from "../src/focus.js";
import { captureGnomeTerminal } from "../src/gnome-bridge.js";
import { startSwitchboardRuntime } from "../src/runtime.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const config = getRuntimeConfig();
const statePath = path.join(config.home, "desktop-state.json");
const trustedOrigin = new URL(config.baseUrl).origin;

let mainWindow = null;
let tray = null;
let ownedRuntime = null;
let client = null;
let quitting = false;
let recreatingWindow = false;
let stoppingRuntime = false;
let saveTimer = null;
let recreateTimer = null;
let desktopState = { pinned: true, bounds: null };
const focusOperations = new Map();

function readDesktopState() {
  try {
    const parsed = JSON.parse(readFileSync(statePath, "utf8"));
    return {
      pinned: parsed.pinned !== false,
      bounds:
        parsed.bounds && ["x", "y", "width", "height"].every((key) => Number.isInteger(parsed.bounds[key]))
          ? parsed.bounds
          : null,
    };
  } catch {
    return { pinned: true, bounds: null };
  }
}

function saveDesktopState() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      writeFileSync(statePath, `${JSON.stringify(desktopState, null, 2)}\n`, { mode: 0o600 });
    } catch {
      // Window state persistence is best effort.
    }
  }, 180);
}

function currentWindowState() {
  return {
    desktop: true,
    pinned: desktopState.pinned,
    hardPinned: process.platform === "linux" && desktopState.pinned,
    visible: Boolean(mainWindow?.isVisible()),
    shortcut: "Ctrl+Shift+Space",
  };
}

function sendWindowState() {
  if (!mainWindow?.isDestroyed()) mainWindow.webContents.send("desktop:state-changed", currentWindowState());
}

function trustedSender(event) {
  try {
    return new URL(event.senderFrame.url).origin === trustedOrigin;
  } catch {
    return false;
  }
}

function applyWindowPin(window) {
  if (!window || window.isDestroyed()) return;
  window.setAlwaysOnTop(desktopState.pinned);
  try {
    window.setVisibleOnAllWorkspaces(desktopState.pinned, { visibleOnFullScreen: desktopState.pinned });
  } catch {
    // Not every window manager supports sticky windows.
  }
  if (desktopState.pinned && process.platform !== "linux") window.moveTop();
}

function revealWindow(window = mainWindow) {
  if (!window || window.isDestroyed()) return;
  applyWindowPin(window);
  if (process.platform === "linux" && desktopState.pinned) window.showInactive();
  else {
    window.show();
    window.focus();
  }
}

function toggleWindow() {
  if (!mainWindow) return;
  if (mainWindow.isVisible()) mainWindow.hide();
  else revealWindow();
  sendWindowState();
}

function scheduleWindowRecreation() {
  clearTimeout(recreateTimer);
  recreateTimer = setTimeout(() => {
    const window = mainWindow;
    if (!window || window.isDestroyed() || quitting) return;
    desktopState.bounds = window.getBounds();
    saveDesktopState();
    recreatingWindow = true;
    mainWindow = null;
    window.destroy();
    recreatingWindow = false;
    createWindow();
    rebuildTrayMenu();
  }, 100);
}

function setPinned(value) {
  const pinned = Boolean(value);
  const changed = pinned !== desktopState.pinned;
  desktopState.pinned = pinned;
  applyWindowPin(mainWindow);
  saveDesktopState();
  rebuildTrayMenu();
  sendWindowState();
  if (changed && process.platform === "linux") scheduleWindowRecreation();
  return currentWindowState();
}

function rebuildTrayMenu() {
  if (!tray) return;
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: mainWindow?.isVisible() ? "Hide Switchboard" : "Show Switchboard", click: toggleWindow },
      { type: "separator" },
      {
        label: "Always on top",
        type: "checkbox",
        checked: desktopState.pinned,
        click: (item) => setPinned(item.checked),
      },
      { type: "separator" },
      {
        label: "Quit",
        click: () => {
          quitting = true;
          app.quit();
        },
      },
    ]),
  );
}

async function ensureDaemon() {
  ensureRuntimeHome(config);
  client = new SwitchboardClient(config);
  try {
    const health = await client.request("/api/v1/health", { timeoutMs: 650 });
    if (health.name !== "Agent Switchboard") throw new Error("Another service is using the Switchboard port");
    return;
  } catch (error) {
    if (error.message.includes("Another service")) throw error;
  }
  ownedRuntime = await startSwitchboardRuntime({ config, discovery: process.platform === "linux" });
  client = new SwitchboardClient(config);
}

function focusSessionOnce(sessionId) {
  const existing = focusOperations.get(sessionId);
  if (existing) return existing;

  const operation = (async () => {
    const detail = await client.session(sessionId);
    const result = await focusSession(detail.session, { reuseAttachedTmux: true });
    if (!result.ok) return result;

    // Switching terminals must not dismiss the switchboard. Keep its current
    // visibility and pin level while allowing the destination terminal to take
    // keyboard focus.
    applyWindowPin(mainWindow);
    if (detail.session.unread) {
      try {
        await client.action(sessionId, "seen");
      } catch (error) {
        console.warn(`Session opened, but its read state could not be updated: ${error.message}`);
      }
    }
    return result;
  })();

  focusOperations.set(sessionId, operation);
  const scheduleRelease = (result) => {
    const timer = setTimeout(
      () => {
        if (focusOperations.get(sessionId) === operation) focusOperations.delete(sessionId);
      },
      result?.launched ? 1800 : 350,
    );
    timer.unref?.();
  };
  operation.then(scheduleRelease, () => scheduleRelease(null));
  return operation;
}

async function linkGnomeTerminalSession(sessionId) {
  const detail = await client.session(sessionId);
  if (detail.session.presence !== "live") {
    return { ok: false, code: "not_live", message: "This session is no longer running." };
  }
  if (detail.session.terminalKind !== "gnome-terminal") {
    return { ok: false, code: "not_gnome_terminal", message: "This session is not running in GNOME Terminal." };
  }
  return captureGnomeTerminal(detail.session, { allowLast: true });
}

function registerIpc() {
  ipcMain.handle("desktop:get-state", (event) => {
    if (!trustedSender(event)) throw new Error("Untrusted renderer");
    return currentWindowState();
  });
  ipcMain.handle("desktop:toggle-pinned", (event) => {
    if (!trustedSender(event)) throw new Error("Untrusted renderer");
    return setPinned(!desktopState.pinned);
  });
  ipcMain.handle("desktop:minimize", (event) => {
    if (!trustedSender(event)) throw new Error("Untrusted renderer");
    mainWindow?.minimize();
  });
  ipcMain.handle("desktop:hide", (event) => {
    if (!trustedSender(event)) throw new Error("Untrusted renderer");
    mainWindow?.hide();
    sendWindowState();
  });
  ipcMain.handle("desktop:focus-session", async (event, sessionId) => {
    if (!trustedSender(event)) throw new Error("Untrusted renderer");
    if (typeof sessionId !== "string" || !/^(codex|claude|opencode):[a-f0-9]{24}$/.test(sessionId)) {
      return { ok: false, code: "invalid_session", message: "The selected session identifier is invalid." };
    }
    return focusSessionOnce(sessionId);
  });
  ipcMain.handle("desktop:link-session", async (event, sessionId) => {
    if (!trustedSender(event)) throw new Error("Untrusted renderer");
    if (typeof sessionId !== "string" || !/^(codex|claude|opencode):[a-f0-9]{24}$/.test(sessionId)) {
      return { ok: false, code: "invalid_session", message: "The selected session identifier is invalid." };
    }
    return linkGnomeTerminalSession(sessionId);
  });
}

function createTray() {
  try {
    const icon = nativeImage.createFromPath(path.join(ROOT, "web", "favicon.svg"));
    tray = new Tray(icon.resize({ width: 20, height: 20 }));
    tray.setToolTip("Agent Switchboard");
    tray.on("click", toggleWindow);
    rebuildTrayMenu();
  } catch {
    tray = null;
  }
}

function createWindow() {
  const workArea = screen.getPrimaryDisplay().workArea;
  const defaultBounds = {
    width: 430,
    height: Math.min(820, workArea.height - 32),
    x: workArea.x + workArea.width - 446,
    y: workArea.y + 16,
  };
  const bounds = desktopState.bounds || defaultBounds;
  const window = new BrowserWindow({
    ...bounds,
    minWidth: 360,
    minHeight: 500,
    show: false,
    frame: false,
    focusable: process.platform !== "linux" || !desktopState.pinned,
    alwaysOnTop: desktopState.pinned,
    backgroundColor: "#090a12",
    title: "Agent Switchboard",
    icon: path.join(ROOT, "web", "favicon.svg"),
    webPreferences: {
      preload: path.join(ROOT, "desktop", "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      spellcheck: false,
      navigateOnDragDrop: false,
      devTools: process.env.SWITCHBOARD_DEVTOOLS === "1",
    },
  });
  mainWindow = window;

  applyWindowPin(window);
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event, target) => {
    if (new URL(target).origin !== trustedOrigin) event.preventDefault();
  });
  window.on("close", (event) => {
    if (quitting || recreatingWindow) return;
    event.preventDefault();
    window.hide();
    sendWindowState();
  });
  window.on("closed", () => {
    if (mainWindow === window) mainWindow = null;
  });
  window.on("move", () => {
    if (mainWindow !== window || window.isDestroyed()) return;
    desktopState.bounds = window.getBounds();
    saveDesktopState();
  });
  window.on("resize", () => {
    if (mainWindow !== window || window.isDestroyed()) return;
    desktopState.bounds = window.getBounds();
    saveDesktopState();
  });
  window.on("blur", () => {
    if (mainWindow === window && desktopState.pinned) applyWindowPin(window);
  });
  window.on("always-on-top-changed", (_event, isAlwaysOnTop) => {
    if (mainWindow === window && desktopState.pinned && !isAlwaysOnTop) applyWindowPin(window);
  });
  window.once("ready-to-show", () => {
    if (mainWindow !== window) return;
    revealWindow(window);
    sendWindowState();
  });
  window.loadURL(config.baseUrl);
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (!mainWindow) return;
    revealWindow();
  });

  app.whenReady().then(async () => {
    app.setName("Agent Switchboard");
    desktopState = readDesktopState();
    try {
      await ensureDaemon();
    } catch (error) {
      dialog.showErrorBox("Switchboard could not start", error.stack || error.message);
      app.quit();
      return;
    }

    session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
    registerIpc();
    createWindow();
    createTray();
    globalShortcut.register("CommandOrControl+Shift+Space", toggleWindow);
  });

  app.on("activate", () => {
    if (mainWindow) revealWindow();
  });
  app.on("window-all-closed", () => {});
  app.on("before-quit", (event) => {
    quitting = true;
    clearTimeout(recreateTimer);
    globalShortcut.unregisterAll();
    if (!ownedRuntime || stoppingRuntime) return;
    event.preventDefault();
    stoppingRuntime = true;
    ownedRuntime
      .stop()
      .catch(() => {})
      .finally(() => {
        ownedRuntime = null;
        app.quit();
      });
  });
}
