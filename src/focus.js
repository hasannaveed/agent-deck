import { constants, accessSync } from "node:fs";
import { execFile, spawn } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import {
  captureGnomeTerminal,
  focusGnomeApplicationWindow,
  focusGnomeTerminal,
} from "./gnome-bridge.js";
import {
  parseTmuxClients,
  terminalTargetForTmuxClient,
  TMUX_CLIENT_FORMAT,
} from "./tmux-clients.js";
import { parseVisualStudioCodeStatus } from "./vscode.js";

const execFileAsync = promisify(execFile);

function executableOnPath(name, env = process.env) {
  if (!name || name.includes(path.sep)) return null;
  for (const directory of String(env.PATH || "").split(path.delimiter)) {
    if (!directory) continue;
    const candidate = path.join(directory, name);
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Keep searching.
    }
  }
  return null;
}

function resolveTerminalLauncher(which) {
  const choices = [
    ["gnome-terminal", ["--"]],
    ["kgx", ["--"]],
    ["ptyxis", ["--"]],
    ["konsole", ["-e"]],
    ["x-terminal-emulator", ["-e"]],
    ["xterm", ["-e"]],
  ];
  for (const [name, prefix] of choices) {
    const file = which(name);
    if (file) return { file, prefix, label: name };
  }
  return null;
}

async function defaultRun(file, args, options = {}) {
  const timeoutMs = Number.isFinite(options.timeoutMs)
    ? Math.max(250, Math.min(5000, options.timeoutMs))
    : 1800;
  return execFileAsync(file, args, {
    encoding: "utf8",
    timeout: timeoutMs,
    maxBuffer: 256 * 1024,
    windowsHide: true,
    ...(options.env ? { env: options.env } : {}),
  });
}

function defaultLaunch(file, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { detached: true, stdio: "ignore" });
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
}

function validNumericTarget(value) {
  const target = String(value || "");
  return /^\d{1,12}$/.test(target) ? target : null;
}

function validTmuxTarget(value) {
  const target = String(value || "");
  return /^%\d{1,12}$/.test(target) ? target : null;
}

function validUnixPath(value) {
  if (!value) return null;
  const instance = String(value);
  return path.isAbsolute(instance) && instance.length <= 2048 ? instance : null;
}

function validKittyAddress(value) {
  if (!value) return null;
  const address = String(value);
  if (address.length > 2048 || /[\u0000-\u001f\u007f]/.test(address)) return null;
  if (address.startsWith("unix:/") || address.startsWith("unix:@")) return address;
  return null;
}

function cleanMessage(error) {
  const source = error?.stderr || error?.message || String(error);
  return String(source).replaceAll(/\s+/g, " ").trim().slice(0, 240);
}

async function focusAttachedTmuxTerminal({
  tmux,
  base,
  sessionName,
  target,
  env,
  which,
  run,
  resolveTmuxClientTerminal,
}) {
  let clients;
  try {
    const result = await run(tmux, [
      ...base,
      "list-clients",
      "-t",
      sessionName,
      "-F",
      TMUX_CLIENT_FORMAT,
    ]);
    clients = parseTmuxClients(result.stdout);
  } catch {
    return null;
  }

  let activationFailure = null;
  for (const client of clients) {
    let terminal;
    try {
      terminal = await resolveTmuxClientTerminal(client.pid);
    } catch {
      continue;
    }
    if (terminal?.terminalKind !== "gnome-terminal") continue;
    let focused = await focusGnomeTerminal(terminal, { env, which, run });
    if (!focused.ok && focused.code === "gnome_terminal_unlinked") {
      const captured = await captureGnomeTerminal(terminal, { env, which, run, allowLast: true });
      if (captured.ok) focused = await focusGnomeTerminal(terminal, { env, which, run });
    }
    if (!focused.ok) {
      activationFailure = focused;
      continue;
    }
    return {
      ok: true,
      provider: "tmux",
      reused: true,
      focused: true,
      clientPid: client.pid,
      message: `Focused the existing tmux terminal at pane ${target}.`,
    };
  }
  return activationFailure;
}

async function focusVisualStudioCode(session, { which, run, launch, env }) {
  const code = which("code") || which("code-insiders");
  if (!code) {
    return {
      ok: false,
      code: "vscode_unavailable",
      message: "The VS Code command-line launcher is not available.",
    };
  }

  const extensionHostPid = validNumericTarget(session.hostPid);
  if (extensionHostPid && which("gdbus")) {
    try {
      const status = await run(code, ["--status"], { timeoutMs: 3500 });
      const window = parseVisualStudioCodeStatus(status.stdout, extensionHostPid);
      if (window) {
        const focused = await focusGnomeApplicationWindow(
          { application: "vscode", pid: window.pid },
          { env, which, run },
        );
        if (focused.ok) {
          return {
            ok: true,
            provider: "vscode",
            reused: true,
            message: focused.message || "Focused the existing VS Code window.",
          };
        }
      }
    } catch {
      // VS Code's diagnostic mapping and the GNOME connector are optional.
      // Opening the known workspace below remains a safe, useful fallback.
    }
  }

  const workspace = validUnixPath(session.cwd);
  if (!workspace) {
    return {
      ok: false,
      code: "vscode_window_unavailable",
      message: "The VS Code window closed and this session has no workspace to reopen.",
    };
  }
  await launch(code, [workspace]);
  return {
    ok: true,
    provider: "vscode",
    launched: true,
    message: `Opened ${session.project || path.basename(workspace)} in VS Code.`,
  };
}

export async function focusSession(
  session,
  {
    env = process.env,
    which = (name) => executableOnPath(name, env),
    run = defaultRun,
    launch = defaultLaunch,
    reuseCurrentTmux = false,
    reuseAttachedTmux = false,
    focusAttachedTmux = false,
    attachCurrentTmux = null,
    resolveTmuxClientTerminal = terminalTargetForTmuxClient,
  } = {},
) {
  if (!session || session.presence !== "live") {
    return { ok: false, code: "not_live", message: "This session is no longer running." };
  }

  try {
    if (session.hostApplication === "vscode") {
      return await focusVisualStudioCode(session, { which, run, launch, env });
    }

    if (session.terminalKind === "tmux") {
      const target = validTmuxTarget(session.terminalTarget);
      const tmux = which("tmux");
      if (!target || !tmux) {
        return { ok: false, code: "tmux_unavailable", message: "The tmux pane can no longer be located." };
      }
      const instance = validUnixPath(session.terminalInstance);
      const currentInstance = validUnixPath(String(env.TMUX || "").split(",", 1)[0]);
      const canReuseCurrentClient = reuseCurrentTmux && instance && currentInstance === instance;
      const base = instance ? ["-S", instance] : [];
      const inspectAttachedClients = reuseAttachedTmux || focusAttachedTmux;
      const format = inspectAttachedClients ? "#{session_name}\t#{session_attached}" : "#{session_name}";
      const result = await run(tmux, [...base, "display-message", "-p", "-t", target, format]);
      const status = String(result.stdout || "").trim();
      const [sessionName, attachedText, ...extra] = status.split("\t");
      if (!sessionName || sessionName.includes("\n") || extra.length) {
        throw new Error("tmux did not return a valid session name");
      }
      const attachedClients = inspectAttachedClients && /^\d+$/.test(attachedText || "") ? Number(attachedText) : 0;
      if (inspectAttachedClients && !/^\d+$/.test(attachedText || "")) {
        throw new Error("tmux did not return its attached-client count");
      }

      await run(tmux, [...base, "select-window", "-t", target, ";", "select-pane", "-t", target]);
      if (canReuseCurrentClient) {
        return { ok: true, provider: "tmux", reused: true, message: `Switched to tmux pane ${target}.` };
      }
      if (focusAttachedTmux && attachedClients > 0) {
        const focused = await focusAttachedTmuxTerminal({
          tmux,
          base,
          sessionName,
          target,
          env,
          which,
          run,
          resolveTmuxClientTerminal,
        });
        if (focused) return focused;
      }
      const canReuseAttachedClient = reuseAttachedTmux && attachedClients > 0;
      if (canReuseAttachedClient) {
        return {
          ok: true,
          provider: "tmux",
          reused: true,
          message: `Switched the attached terminal to tmux pane ${target}.`,
        };
      }
      const canAttachCurrentTerminal = typeof attachCurrentTmux === "function";
      if (canAttachCurrentTerminal) {
        await attachCurrentTmux(tmux, [...base, "attach-session", "-t", sessionName]);
        return {
          ok: true,
          provider: "tmux",
          reused: true,
          attached: true,
          message: `Returned from tmux pane ${target}.`,
        };
      }
      const terminal = resolveTerminalLauncher(which);
      if (!terminal) {
        return {
          ok: false,
          code: "terminal_unavailable",
          message: "No attached tmux client or supported graphical terminal was found.",
        };
      }
      await launch(terminal.file, [...terminal.prefix, tmux, ...base, "attach-session", "-t", sessionName]);
      return {
        ok: true,
        provider: "tmux",
        launched: true,
        message: `Opened ${target} in ${terminal.label}.`,
      };
    }

    if (session.terminalKind === "wezterm") {
      const target = validNumericTarget(session.terminalTarget);
      const wezterm = which("wezterm");
      if (!target || !wezterm) {
        return { ok: false, code: "wezterm_unavailable", message: "The WezTerm pane can no longer be located." };
      }
      const instance = validUnixPath(session.terminalInstance);
      await run(wezterm, ["cli", "activate-pane", "--pane-id", target], {
        env: instance ? { ...env, WEZTERM_UNIX_SOCKET: instance } : env,
      });
      return { ok: true, provider: "wezterm", reused: true, message: `Focused WezTerm pane ${target}.` };
    }

    if (session.terminalKind === "kitty") {
      const target = validNumericTarget(session.terminalTarget);
      const controller = which("kitten") || which("kitty");
      const address = validKittyAddress(session.terminalInstance);
      if (!target || !controller || !address) {
        return {
          ok: false,
          code: "kitty_unavailable",
          message: "kitty needs allow_remote_control and a KITTY_LISTEN_ON socket for desktop switching.",
        };
      }
      await run(controller, ["@", "--to", address, "focus-window", "--match", `id:${target}`]);
      return { ok: true, provider: "kitty", reused: true, message: `Focused kitty window ${target}.` };
    }

    if (session.terminalKind === "zellij") {
      const target = String(session.terminalTarget || "").trim();
      const zellij = which("zellij");
      const terminal = resolveTerminalLauncher(which);
      if (!target || target.length > 200 || !zellij || !terminal) {
        return { ok: false, code: "zellij_unavailable", message: "The Zellij session can no longer be located." };
      }
      await launch(terminal.file, [...terminal.prefix, zellij, "attach", target]);
      return { ok: true, provider: "zellij", launched: true, message: `Opened Zellij session ${target}.` };
    }

    if (session.terminalKind === "gnome-terminal") {
      return focusGnomeTerminal(session, { env, which, run });
    }
  } catch (error) {
    return { ok: false, code: "focus_failed", message: `Could not open the session: ${cleanMessage(error)}` };
  }

  return {
    ok: false,
    code: "unsupported_terminal",
    message: "Direct switching needs a supported application host, tmux, WezTerm, kitty, Zellij, or an automatically routed GNOME Terminal screen.",
  };
}
