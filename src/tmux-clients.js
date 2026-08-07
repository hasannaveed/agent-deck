import { execFileSync } from "node:child_process";
import path from "node:path";
import { readProcessInfo } from "./discovery/linux.js";

export const TMUX_CLIENT_FORMAT = "#{client_pid}\t#{client_activity}\t#{client_name}";

export function parseTmuxClients(value) {
  const clients = [];
  for (const line of String(value || "").split("\n")) {
    if (!line) continue;
    const fields = line.split("\t");
    if (fields.length !== 3 || !/^\d{1,10}$/.test(fields[0]) || !/^\d{1,16}$/.test(fields[1])) continue;
    const pid = Number(fields[0]);
    const activity = Number(fields[1]);
    const name = fields[2].replaceAll(/[\u0000-\u001f\u007f]/g, "").slice(0, 256);
    if (!Number.isSafeInteger(pid) || pid <= 1 || !Number.isSafeInteger(activity)) continue;
    clients.push({ pid, activity, name });
  }
  return clients.sort((left, right) => right.activity - left.activity || right.pid - left.pid);
}

export function terminalTargetForTmuxClient(pid, read = readProcessInfo) {
  if (!Number.isSafeInteger(Number(pid)) || Number(pid) <= 1) return null;
  const info = read(Number(pid));
  if (!info || !["gnome-terminal", "wezterm", "kitty"].includes(info.terminalKind)) return null;
  return {
    terminalKind: info.terminalKind,
    terminalTarget: info.terminalTarget,
    terminalInstance: info.terminalInstance,
  };
}

export function newestAttachedTmuxClientTerminal(
  terminal,
  { execute = execFileSync, resolve = terminalTargetForTmuxClient } = {},
) {
  const target = String(terminal?.terminalTarget || "");
  const instance = terminal?.terminalInstance ? String(terminal.terminalInstance) : null;
  if (!/^%\d{1,12}$/.test(target)) return null;
  if (instance && (!path.isAbsolute(instance) || instance.length > 2048)) return null;

  const args = instance ? ["-S", instance] : [];
  args.push("list-clients", "-t", target, "-F", TMUX_CLIENT_FORMAT);
  try {
    const output = execute("tmux", args, {
      encoding: "utf8",
      timeout: 500,
      stdio: ["ignore", "pipe", "ignore"],
    });
    for (const client of parseTmuxClients(output)) {
      const resolved = resolve(client.pid);
      if (resolved) return { ...resolved, client };
    }
  } catch {
    // A detached or closing tmux session simply has no reusable terminal.
  }
  return null;
}
