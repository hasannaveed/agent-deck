import { execFile } from "node:child_process";
import { constants, accessSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const GNOME_BRIDGE_NAME = "com.skylabs.AgentSwitchboard.GnomeBridge";
export const GNOME_BRIDGE_PATH = "/com/skylabs/AgentSwitchboard/GnomeBridge";
export const GNOME_BRIDGE_INTERFACE = "com.skylabs.AgentSwitchboard.GnomeBridge1";

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

function defaultRun(file, args, options = {}) {
  return execFileAsync(file, args, {
    encoding: "utf8",
    timeout: 1500,
    maxBuffer: 64 * 1024,
    windowsHide: true,
    ...options,
  });
}

export function validGnomeTerminalService(value) {
  const service = String(value || "");
  return /^:\d{1,10}\.\d{1,10}$/.test(service) ? service : null;
}

export function validGnomeTerminalScreen(value) {
  const screen = String(value || "");
  return /^\/org\/gnome\/Terminal\/screen\/[a-zA-Z0-9_]{1,160}$/.test(screen) ? screen : null;
}

export function validGnomeApplication(value) {
  const application = String(value || "").toLowerCase();
  return application === "vscode" ? application : null;
}

export function validGnomeWindowPid(value) {
  const pid = Number(value);
  return Number.isInteger(pid) && pid > 1 && pid <= 2_147_483_647 ? pid : null;
}

function cleanMessage(value) {
  return String(value || "").replaceAll(/\s+/g, " ").trim().slice(0, 240);
}

function bridgeReplyMessage(method, message) {
  const cleaned = cleanMessage(message);
  if (
    method === "FocusTerminal" &&
    /(?:not linked yet|automatic linking was missed)/i.test(cleaned)
  ) {
    return "Automatic terminal linking was missed. Focus the target tab, then use Repair terminal jump or run switchboardctl link there.";
  }
  return cleaned;
}

export function parseGnomeBridgeReply(value) {
  const output = String(value || "").trim();
  const success = output.match(/^\(\s*(true|false)\s*,/);
  if (!success) return null;
  const quoted = output.match(/,\s*'((?:\\.|[^'])*)'\s*\)$/s);
  const message = quoted
    ? quoted[1].replaceAll("\\'", "'").replaceAll("\\n", " ").replaceAll("\\\\", "\\")
    : "";
  return { ok: success[1] === "true", message: cleanMessage(message) };
}

function bridgeUnavailableMessage(error) {
  const detail = cleanMessage(error?.stderr || error?.message || error);
  if (/ServiceUnknown|NameHasNoOwner|not provided by any \.service|does not exist/i.test(detail)) {
    return "The GNOME connector is not running. Install or enable it with npm run gnome:install.";
  }
  return detail ? `The GNOME connector could not be reached: ${detail}` : "The GNOME connector could not be reached.";
}

function applicationBridgeFailure(error) {
  const detail = cleanMessage(error?.stderr || error?.message || error);
  if (/UnknownMethod|No such method.*FocusApplicationWindow/i.test(detail)) {
    return {
      ok: false,
      code: "gnome_bridge_upgrade_required",
      message: "GNOME is still running an older Switchboard connector. Run npm run gnome:install, then log out and back in once.",
    };
  }
  return { ok: false, code: "gnome_bridge_unavailable", message: bridgeUnavailableMessage(error) };
}

async function invokeBridge(
  method,
  terminal,
  { env = process.env, which = (name) => executableOnPath(name, env), run = defaultRun, allowLast = false } = {},
) {
  const service = validGnomeTerminalService(terminal?.terminalInstance);
  const screen = validGnomeTerminalScreen(terminal?.terminalTarget);
  const gdbus = which("gdbus");
  if (!service || !screen) {
    return {
      ok: false,
      code: "gnome_terminal_unavailable",
      message: "This GNOME Terminal session does not expose a safe screen identifier.",
    };
  }
  if (!gdbus) {
    return {
      ok: false,
      code: "gnome_bridge_unavailable",
      message: "gdbus is required for GNOME Terminal switching.",
    };
  }

  const args = [
    "call",
    "--session",
    "--dest",
    GNOME_BRIDGE_NAME,
    "--object-path",
    GNOME_BRIDGE_PATH,
    "--method",
    `${GNOME_BRIDGE_INTERFACE}.${method}`,
    service,
    screen,
  ];
  if (method === "CaptureTerminal") args.push(allowLast ? "true" : "false");

  try {
    const result = await run(gdbus, args);
    const reply = parseGnomeBridgeReply(result.stdout);
    if (!reply) {
      return {
        ok: false,
        code: "gnome_bridge_invalid_reply",
        message: "The GNOME connector returned an invalid response.",
      };
    }
    const message = bridgeReplyMessage(method, reply.message);
    return reply.ok
      ? { ok: true, message }
      : {
          ok: false,
          code: method === "CaptureTerminal" ? "gnome_terminal_link_failed" : "gnome_terminal_unlinked",
          message: message || "This GNOME Terminal screen does not have an automatic jump route yet.",
        };
  } catch (error) {
    return { ok: false, code: "gnome_bridge_unavailable", message: bridgeUnavailableMessage(error) };
  }
}

export async function focusGnomeTerminal(terminal, options = {}) {
  const result = await invokeBridge("FocusTerminal", terminal, options);
  return result.ok
    ? {
        ok: true,
        provider: "gnome-terminal",
        reused: true,
        message: result.message || "Focused the linked GNOME Terminal tab.",
      }
    : result;
}

export function captureGnomeTerminal(terminal, options = {}) {
  return invokeBridge("CaptureTerminal", terminal, options);
}

export async function focusGnomeApplicationWindow(
  target,
  {
    env = process.env,
    which = (name) => executableOnPath(name, env),
    run = defaultRun,
  } = {},
) {
  const application = validGnomeApplication(target?.application);
  const pid = validGnomeWindowPid(target?.pid);
  if (!application || !pid) {
    return {
      ok: false,
      code: "gnome_application_unavailable",
      message: "This application session does not expose a safe window target.",
    };
  }
  const gdbus = which("gdbus");
  if (!gdbus) {
    return {
      ok: false,
      code: "gnome_bridge_unavailable",
      message: "gdbus is required for application switching.",
    };
  }

  try {
    const result = await run(gdbus, [
      "call",
      "--session",
      "--dest",
      GNOME_BRIDGE_NAME,
      "--object-path",
      GNOME_BRIDGE_PATH,
      "--method",
      `${GNOME_BRIDGE_INTERFACE}.FocusApplicationWindow`,
      String(pid),
      application,
    ]);
    const reply = parseGnomeBridgeReply(result.stdout);
    if (!reply) {
      return {
        ok: false,
        code: "gnome_bridge_invalid_reply",
        message: "The GNOME connector returned an invalid response.",
      };
    }
    return reply.ok
      ? reply
      : {
          ok: false,
          code: "gnome_application_unavailable",
          message: reply.message || "The application window is no longer available.",
        };
  } catch (error) {
    return applicationBridgeFailure(error);
  }
}

export async function raiseGnomeSwitchboard({
  env = process.env,
  which = (name) => executableOnPath(name, env),
  run = defaultRun,
} = {}) {
  const gdbus = which("gdbus");
  if (!gdbus) {
    return { ok: false, code: "gnome_bridge_unavailable", message: "gdbus is required to raise Switchboard." };
  }

  try {
    const result = await run(gdbus, [
      "call",
      "--session",
      "--dest",
      GNOME_BRIDGE_NAME,
      "--object-path",
      GNOME_BRIDGE_PATH,
      "--method",
      `${GNOME_BRIDGE_INTERFACE}.RaiseSwitchboard`,
    ]);
    const reply = parseGnomeBridgeReply(result.stdout);
    return reply || {
      ok: false,
      code: "gnome_bridge_invalid_reply",
      message: "The GNOME connector returned an invalid response.",
    };
  } catch (error) {
    return { ok: false, code: "gnome_bridge_unavailable", message: bridgeUnavailableMessage(error) };
  }
}
