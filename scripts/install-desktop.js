#!/usr/bin/env node

import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ELECTRON = path.join(ROOT, "node_modules", ".bin", "electron");
const RUNNER = path.join(ROOT, "scripts", "run-desktop.js");
const ICON = path.join(ROOT, "web", "favicon.svg");
const autostart = process.argv.includes("--autostart");
const force = process.argv.includes("--force");

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
X-Agent-Switchboard-Owned=true
`;

function ownedEntry(target) {
  if (!existsSync(target)) return true;
  const metadata = lstatSync(target);
  if (metadata.isSymbolicLink() || !metadata.isFile()) return false;
  const current = readFileSync(target, "utf8");
  return (
    current.includes("X-Agent-Switchboard-Owned=true") ||
    (current.includes("Name=Agent Switchboard") && current.includes("StartupWMClass=agent-switchboard"))
  );
}

function installEntry(target, label) {
  if (!ownedEntry(target) && !force) {
    throw new Error(`${target} already exists and is not owned by Agent Switchboard; it was left unchanged.`);
  }
  mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  const temporary = path.join(path.dirname(target), `.${path.basename(target)}.${process.pid}.tmp`);
  try {
    writeFileSync(temporary, entry, { encoding: "utf8", mode: 0o644, flag: "wx" });
    renameSync(temporary, target);
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary);
  }
  process.stdout.write(`${label}: ${target}\n`);
}

const dataHome = process.env.XDG_DATA_HOME || path.join(homedir(), ".local", "share");
const applicationDirectory = path.join(dataHome, "applications");
const applicationPath = path.join(applicationDirectory, "agent-switchboard.desktop");
installEntry(applicationPath, "Installed desktop launcher");

if (autostart) {
  const configHome = process.env.XDG_CONFIG_HOME || path.join(homedir(), ".config");
  const autostartDirectory = path.join(configHome, "autostart");
  const autostartPath = path.join(autostartDirectory, "agent-switchboard.desktop");
  installEntry(autostartPath, "Enabled login autostart");
}
