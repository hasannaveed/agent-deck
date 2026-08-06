import { constants, accessSync } from "node:fs";
import { execFile, spawn } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

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
  return execFileAsync(file, args, {
    encoding: "utf8",
    timeout: 1800,
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

export async function focusSession(
  session,
  {
    env = process.env,
    which = (name) => executableOnPath(name, env),
    run = defaultRun,
    launch = defaultLaunch,
    reuseCurrentTmux = false,
    reuseAttachedTmux = false,
  } = {},
) {
  if (!session || session.presence !== "live") {
    return { ok: false, code: "not_live", message: "This session is no longer running." };
  }

  try {
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
      const format = reuseAttachedTmux ? "#{session_name}\t#{session_attached}" : "#{session_name}";
      const result = await run(tmux, [...base, "display-message", "-p", "-t", target, format]);
      const status = String(result.stdout || "").trim();
      const [sessionName, attachedText, ...extra] = status.split("\t");
      if (!sessionName || sessionName.includes("\n") || extra.length) {
        throw new Error("tmux did not return a valid session name");
      }
      const attachedClients = reuseAttachedTmux && /^\d+$/.test(attachedText || "") ? Number(attachedText) : 0;
      if (reuseAttachedTmux && !/^\d+$/.test(attachedText || "")) {
        throw new Error("tmux did not return its attached-client count");
      }
      const canReuseAttachedClient = reuseAttachedTmux && attachedClients > 0;
      const terminal = canReuseCurrentClient || canReuseAttachedClient ? null : resolveTerminalLauncher(which);
      if (!canReuseCurrentClient && !canReuseAttachedClient && !terminal) {
        return {
          ok: false,
          code: "terminal_unavailable",
          message: "No attached tmux client or supported graphical terminal was found.",
        };
      }

      await run(tmux, [...base, "select-window", "-t", target, ";", "select-pane", "-t", target]);
      if (canReuseCurrentClient) {
        return { ok: true, provider: "tmux", reused: true, message: `Switched to tmux pane ${target}.` };
      }
      if (canReuseAttachedClient) {
        return {
          ok: true,
          provider: "tmux",
          reused: true,
          message: `Switched the attached terminal to tmux pane ${target}.`,
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
  } catch (error) {
    return { ok: false, code: "focus_failed", message: `Could not open the session: ${cleanMessage(error)}` };
  }

  return {
    ok: false,
    code: "unsupported_terminal",
    message: "Direct switching needs tmux, WezTerm, kitty, or Zellij metadata for this session.",
  };
}
