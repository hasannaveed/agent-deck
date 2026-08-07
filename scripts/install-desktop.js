#!/usr/bin/env node

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ELECTRON = path.join(ROOT, "node_modules", ".bin", "electron");
const RUNNER = path.join(ROOT, "scripts", "run-desktop.js");
const ICON = path.join(ROOT, "web", "favicon.svg");
const autostart = process.argv.includes("--autostart");

function quoteExec(value) {
  return `"${String(value).replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

if (!existsSync(ELECTRON)) {
  process.stderr.write("Electron is not installed. Run npm install first.\n");
  process.exit(1);
}

const entry = `[Desktop Entry]
Type=Application
Version=1.0
Name=Agent Switchboard
Comment=Monitor active Codex, Claude Code, and OpenCode sessions
Exec=${quoteExec(process.execPath)} ${quoteExec(RUNNER)}
Icon=${ICON}
Terminal=false
Categories=Development;
StartupNotify=true
StartupWMClass=agent-switchboard
X-GNOME-Autostart-enabled=true
`;

const dataHome = process.env.XDG_DATA_HOME || path.join(homedir(), ".local", "share");
const applicationDirectory = path.join(dataHome, "applications");
const applicationPath = path.join(applicationDirectory, "agent-switchboard.desktop");
mkdirSync(applicationDirectory, { recursive: true, mode: 0o700 });
writeFileSync(applicationPath, entry, { mode: 0o644 });
process.stdout.write(`Installed desktop launcher: ${applicationPath}\n`);

if (autostart) {
  const configHome = process.env.XDG_CONFIG_HOME || path.join(homedir(), ".config");
  const autostartDirectory = path.join(configHome, "autostart");
  const autostartPath = path.join(autostartDirectory, "agent-switchboard.desktop");
  mkdirSync(autostartDirectory, { recursive: true, mode: 0o700 });
  writeFileSync(autostartPath, entry, { mode: 0o644 });
  process.stdout.write(`Enabled login autostart: ${autostartPath}\n`);
}
