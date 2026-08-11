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
import { captureGnomeTerminal, raiseGnomeSwitchboard } from "../src/gnome-bridge.js";
import { startSwitchboardRuntime } from "../src/runtime.js";
import {
  COLLAPSED_HEIGHT,
  COLLAPSED_WIDTH,
  collapsedBoundsAtBottomRight,
  DESKTOP_LAYOUT_VERSION,
  EXPANDED_MIN_HEIGHT,
  EXPANDED_MIN_WIDTH,
  expandedBoundsAtBottomRight,
} from "./window-layout.js";
import { keepPinnedWindowVisibleAfterJump } from "./window-presence.js";
import {
  defaultDesktopState,
  normalizeDesktopState,
  rememberableExpandedBounds,
} from "./window-state.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const config = getRuntimeConfig();
const statePath = path.join(config.home, "desktop-state.json");
const trustedOrigin = new URL(config.baseUrl).origin;

let mainWindow = null;
let tray = null;
let ownedRuntime = null;
let client = null;
let quitting = false;
let stoppingRuntime = false;
let saveTimer = null;
let visibilityRevision = 0;
let changingWindowMode = false;
let desktopState = defaultDesktopState();
const focusOperations = new Map();

function readDesktopState() {
  try {
    return normalizeDesktopState(JSON.parse(readFileSync(statePath, "utf8")));
  } catch {
    return defaultDesktopState();
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
    collapsed: desktopState.collapsed,
    hardPinned: process.platform === "linux" && (desktopState.pinned || desktopState.collapsed),
    visible: Boolean(mainWindow?.isVisible()),
    shortcut: "Ctrl+Shift+Space",
  };
}

function windowShouldStayOnTop() {
  return true;
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
  const alwaysOnTop = windowShouldStayOnTop();
  window.setAlwaysOnTop(alwaysOnTop);
  try {
    window.setVisibleOnAllWorkspaces(alwaysOnTop, { visibleOnFullScreen: alwaysOnTop });
  } catch {
    // Not every window manager supports sticky windows.
  }
  if (alwaysOnTop && process.platform !== "linux") window.moveTop();
}

function revealWindow(window = mainWindow) {
  if (!window || window.isDestroyed()) return;
  applyWindowPin(window);
  if (process.platform === "linux" && windowShouldStayOnTop()) window.showInactive();
  else {
    window.show();
    window.focus();
  }
}

function toggleWindow() {
  setWindowCollapsed(!desktopState.collapsed);
}

function displayForWindow(window = mainWindow) {
  if (!window || window.isDestroyed()) return screen.getPrimaryDisplay();
  return screen.getDisplayMatching(window.getBounds());
}

function rememberExpandedBounds(window = mainWindow) {
  if (!window || window.isDestroyed() || desktopState.collapsed || changingWindowMode) return;
  const bounds = rememberableExpandedBounds(window, {
    minWidth: EXPANDED_MIN_WIDTH,
    minHeight: EXPANDED_MIN_HEIGHT,
  });
  if (!bounds) return;
  desktopState.expandedBounds = bounds;
}

function restoreExpectedWindowMode(window = mainWindow) {
  if (!window || window.isDestroyed() || changingWindowMode) return;
  const workArea = displayForWindow(window).workArea;
  const normalBounds = window.getNormalBounds?.() || desktopState.expandedBounds;
  changingWindowMode = true;
  if (window.isFullScreen?.()) window.setFullScreen(false);
  if (window.isMaximized?.()) window.unmaximize();

  if (desktopState.collapsed) {
    window.setMinimumSize(COLLAPSED_WIDTH, COLLAPSED_HEIGHT);
    window.setResizable(false);
    window.setBounds(collapsedBoundsAtBottomRight(workArea));
  } else {
    window.setResizable(true);
    window.setMinimumSize(EXPANDED_MIN_WIDTH, EXPANDED_MIN_HEIGHT);
    const expandedBounds = expandedBoundsAtBottomRight(workArea, normalBounds);
    desktopState.expandedBounds = expandedBounds;
    window.setBounds(expandedBounds);
  }

  applyWindowPin(window);
  revealWindow(window);
  saveDesktopState();
  sendWindowState();
  setImmediate(() => {
    changingWindowMode = false;
  });
}

function setWindowCollapsed(value) {
  const window = mainWindow;
  if (!window || window.isDestroyed()) return currentWindowState();
  const collapsed = Boolean(value);
  if (collapsed === desktopState.collapsed) {
    revealWindow(window);
    return currentWindowState();
  }

  visibilityRevision += 1;
  if (collapsed) rememberExpandedBounds(window);
  desktopState.collapsed = collapsed;
  desktopState.layoutVersion = DESKTOP_LAYOUT_VERSION;
  const workArea = displayForWindow(window).workArea;
  changingWindowMode = true;
  if (window.isFullScreen?.()) window.setFullScreen(false);
  if (window.isMaximized?.()) window.unmaximize();
  if (collapsed) {
    window.setMinimumSize(COLLAPSED_WIDTH, COLLAPSED_HEIGHT);
    window.setResizable(false);
    window.setBounds(collapsedBoundsAtBottomRight(workArea));
  } else {
    window.setResizable(true);
    window.setMinimumSize(EXPANDED_MIN_WIDTH, EXPANDED_MIN_HEIGHT);
    const expandedBounds = expandedBoundsAtBottomRight(workArea, desktopState.expandedBounds);
    desktopState.expandedBounds = expandedBounds;
    window.setBounds(expandedBounds);
  }
  applyWindowPin(window);
  revealWindow(window);
  saveDesktopState();
  rebuildTrayMenu();
  sendWindowState();
  setImmediate(() => {
    changingWindowMode = false;
  });
  return currentWindowState();
}

function rebuildTrayMenu() {
  if (!tray) return;
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: desktopState.collapsed ? "Expand Switchboard" : "Collapse Switchboard", click: toggleWindow },
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
    const switchboardWindow = mainWindow;
    const restoreRevision = visibilityRevision;
    const wasVisible = Boolean(switchboardWindow?.isVisible());
    const detail = await client.session(sessionId);
    const result = await focusSession(detail.session, {
      reuseAttachedTmux: true,
      focusAttachedTmux: true,
    });
    if (!result.ok) return result;

    // GNOME may drop a non-focusable Wayland window behind the activated
    // terminal even when Electron still reports it as visible. Re-show and
    // re-raise the pinned pane without reclaiming keyboard focus.
    keepPinnedWindowVisibleAfterJump({
      window: switchboardWindow,
      shouldRestore: () =>
        wasVisible &&
        mainWindow === switchboardWindow &&
        visibilityRevision === restoreRevision,
      applyPin: applyWindowPin,
    });
    if (
      process.platform === "linux" &&
      wasVisible &&
      mainWindow === switchboardWindow &&
      visibilityRevision === restoreRevision
    ) {
      void raiseGnomeSwitchboard();
    }
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
  ipcMain.handle("desktop:minimize", (event) => {
    if (!trustedSender(event)) throw new Error("Untrusted renderer");
    return setWindowCollapsed(true);
  });
  ipcMain.handle("desktop:hide", (event) => {
    if (!trustedSender(event)) throw new Error("Untrusted renderer");
    return setWindowCollapsed(true);
  });
  ipcMain.handle("desktop:expand", (event) => {
    if (!trustedSender(event)) throw new Error("Untrusted renderer");
    return setWindowCollapsed(false);
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
  const expandedBounds = expandedBoundsAtBottomRight(workArea, desktopState.expandedBounds);
  desktopState.layoutVersion = DESKTOP_LAYOUT_VERSION;
  desktopState.expandedBounds = expandedBounds;
  const bounds = desktopState.collapsed
    ? collapsedBoundsAtBottomRight(workArea)
    : expandedBounds;
  const window = new BrowserWindow({
    ...bounds,
    minWidth: desktopState.collapsed ? COLLAPSED_WIDTH : EXPANDED_MIN_WIDTH,
    minHeight: desktopState.collapsed ? COLLAPSED_HEIGHT : EXPANDED_MIN_HEIGHT,
    resizable: !desktopState.collapsed,
    show: false,
    frame: false,
    focusable: true,
    alwaysOnTop: windowShouldStayOnTop(),
    maximizable: false,
    fullscreenable: false,
    backgroundColor: "#070707",
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
  saveDesktopState();

  applyWindowPin(window);
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("page-title-updated", (event) => {
    event.preventDefault();
    if (!window.isDestroyed()) window.setTitle("Agent Switchboard");
  });
  window.webContents.on("will-navigate", (event, target) => {
    if (new URL(target).origin !== trustedOrigin) event.preventDefault();
  });
  window.on("close", (event) => {
    if (quitting) return;
    event.preventDefault();
    setWindowCollapsed(true);
  });
  window.on("closed", () => {
    if (mainWindow === window) mainWindow = null;
  });
  window.on("move", () => {
    if (mainWindow !== window || window.isDestroyed()) return;
    rememberExpandedBounds(window);
    saveDesktopState();
  });
  window.on("resize", () => {
    if (mainWindow !== window || window.isDestroyed()) return;
    rememberExpandedBounds(window);
    saveDesktopState();
  });
  window.on("maximize", () => {
    setImmediate(() => restoreExpectedWindowMode(window));
  });
  window.on("enter-full-screen", () => {
    setImmediate(() => restoreExpectedWindowMode(window));
  });
  window.on("blur", () => {
    if (mainWindow === window && windowShouldStayOnTop()) applyWindowPin(window);
  });
  window.on("always-on-top-changed", (_event, isAlwaysOnTop) => {
    if (mainWindow === window && windowShouldStayOnTop() && !isAlwaysOnTop) applyWindowPin(window);
  });
  window.once("ready-to-show", () => {
    if (mainWindow !== window) return;
    revealWindow(window);
    sendWindowState();
  });
  const desktopUrl = new URL(config.baseUrl);
  desktopUrl.searchParams.set("desktop", String(Date.now()));
  window.loadURL(desktopUrl.href);
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (!mainWindow) return;
    setWindowCollapsed(false);
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
    if (mainWindow) setWindowCollapsed(false);
  });
  app.on("window-all-closed", () => {});
  app.on("before-quit", (event) => {
    quitting = true;
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
