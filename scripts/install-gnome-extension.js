#!/usr/bin/env node

import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE = path.join(ROOT, "integrations", "gnome-shell");
const UUID = "agent-switchboard@skylabs-ai.com";

function run(command, args, { quiet = false } = {}) {
  const result = spawnSync(command, args, { encoding: "utf8" });
  if (!quiet && result.status !== 0) {
    const detail = String(result.stderr || result.stdout || "").trim();
    throw new Error(detail || `${command} exited with status ${result.status}`);
  }
  return result;
}

if (process.platform !== "linux") throw new Error("The GNOME connector is only available on Linux.");

const shellVersion = run("gnome-shell", ["--version"]).stdout.trim();
if (!/GNOME Shell (42|43|44)\b/.test(shellVersion)) {
  throw new Error(`${shellVersion || "This GNOME Shell version"} is not supported by the bundled connector.`);
}

const temporaryDirectory = mkdtempSync(path.join(tmpdir(), "agent-switchboard-gnome-"));
try {
  run("gnome-extensions", ["pack", "--force", "--out-dir", temporaryDirectory, SOURCE]);
  const bundle = readdirSync(temporaryDirectory).find((name) => name.endsWith(".shell-extension.zip"));
  if (!bundle) throw new Error("gnome-extensions did not create an extension bundle");
  run("gnome-extensions", ["install", "--force", path.join(temporaryDirectory, bundle)]);

  // Reload is useful for upgrades. A newly installed extension may not be known
  // until the shell's directory monitor runs, so failure here is non-fatal.
  run(
    "gdbus",
    [
      "call",
      "--session",
      "--dest",
      "org.gnome.Shell",
      "--object-path",
      "/org/gnome/Shell",
      "--method",
      "org.gnome.Shell.Extensions.ReloadExtension",
      UUID,
    ],
    { quiet: true },
  );

  const enabled = run("gnome-extensions", ["enable", UUID], { quiet: true });
  const info = run("gnome-extensions", ["info", UUID], { quiet: true });
  if (enabled.status === 0 && info.status === 0) {
    process.stdout.write(`Installed and enabled ${UUID}.\n`);
  } else {
    const dataHome = process.env.XDG_DATA_HOME || path.join(homedir(), ".local", "share");
    process.stdout.write(`Installed ${UUID} under ${path.join(dataHome, "gnome-shell", "extensions")}.\n`);
    process.stdout.write("GNOME Shell has not loaded it yet. Log out and back in, then run:\n");
    process.stdout.write(`  gnome-extensions enable ${UUID}\n`);
  }
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
