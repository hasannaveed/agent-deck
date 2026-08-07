#!/usr/bin/env node

import { accessSync, constants, existsSync, lstatSync, readFileSync, rmSync, unlinkSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  getRuntimeConfig,
  STATE_OWNERSHIP_CONTENT,
  STATE_OWNERSHIP_MARKER,
} from "../src/config.js";
import { resolveSetupPaths, uninstallHarnessHooks } from "./harness-hooks.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const rawArgs = process.argv.slice(2);
const args = new Set(rawArgs);
const dryRun = args.has("--dry-run");
const purge = args.has("--purge");
const paths = resolveSetupPaths();
const allowedArgs = new Set(["--dry-run", "--help", "--purge"]);

function usage() {
  return `Agent Switchboard uninstall

Usage: npm run uninstall -- [options]

  --dry-run   report what would be removed without changing anything
  --purge     also remove Switchboard's runtime database and preferences
`;
}

function executableOnPath(name) {
  for (const directory of String(process.env.PATH || "").split(path.delimiter)) {
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

function removeOwnedFile(label, target, owns) {
  if (!existsSync(target)) {
    process.stdout.write(`  ${label}: not installed\n`);
    return;
  }
  let content;
  try {
    const metadata = lstatSync(target);
    if (metadata.isSymbolicLink() || !metadata.isFile()) throw new Error("not a regular file");
    content = readFileSync(target, "utf8");
  } catch (error) {
    process.stdout.write(`  ${label}: preserved ${target} (${error.message})\n`);
    return;
  }
  if (!owns(content)) {
    process.stdout.write(`  ${label}: preserved unrecognized file ${target}\n`);
    return;
  }
  if (!dryRun) unlinkSync(target);
  process.stdout.write(`  ${label}: ${dryRun ? "would remove" : "removed"} ${target}\n`);
}

function desktopEntryOwned(content) {
  return (
    content.includes("X-Agent-Switchboard-Owned=true") ||
    (content.includes("Name=Agent Switchboard") && content.includes("StartupWMClass=agent-switchboard"))
  );
}

function removeGnomeExtension() {
  const target = paths.gnomeExtension;
  if (!existsSync(target)) {
    process.stdout.write("  GNOME connector: not installed\n");
    return;
  }
  const metadataPath = path.join(target, "metadata.json");
  let metadata;
  try {
    metadata = JSON.parse(readFileSync(metadataPath, "utf8"));
  } catch {
    process.stdout.write(`  GNOME connector: preserved unrecognized directory ${target}\n`);
    return;
  }
  if (metadata.uuid !== "agent-switchboard@skylabs-ai.com") {
    process.stdout.write(`  GNOME connector: preserved foreign extension ${target}\n`);
    return;
  }

  if (!dryRun) {
    const extensions = executableOnPath("gnome-extensions");
    if (extensions) {
      spawnSync(extensions, ["disable", metadata.uuid], { encoding: "utf8" });
    }
    rmSync(target, { recursive: true, force: true });
  }
  process.stdout.write(`  GNOME connector: ${dryRun ? "would remove" : "removed"} ${target}\n`);
}

function removeTmuxEnvironmentMarker() {
  const tmux = executableOnPath("tmux");
  if (!tmux) return;
  const current = spawnSync(tmux, ["show-options", "-gv", "update-environment"], { encoding: "utf8" });
  if (current.status !== 0) return;
  const values = String(current.stdout || "").split(/\s+/).filter(Boolean);
  if (!values.includes("AGENT_SWITCHBOARD_CHILD")) return;
  const next = values.filter((value) => value !== "AGENT_SWITCHBOARD_CHILD");
  if (!dryRun) {
    spawnSync(tmux, ["set-option", "-g", "update-environment", next.join(" ")], { encoding: "utf8" });
  }
  process.stdout.write(`  tmux marker: ${dryRun ? "would remove" : "removed"} AGENT_SWITCHBOARD_CHILD\n`);
}

function safePurgeTarget(target) {
  const resolved = path.resolve(target);
  const forbidden = new Set([
    path.parse(resolved).root,
    paths.userHome,
    paths.configHome,
    paths.dataHome,
    path.dirname(paths.userHome),
  ]);
  const targetContainsCheckout = path.relative(resolved, ROOT);
  if (
    forbidden.has(resolved) ||
    resolved.split(path.sep).filter(Boolean).length < 3 ||
    targetContainsCheckout === "" ||
    (!targetContainsCheckout.startsWith("..") && !path.isAbsolute(targetContainsCheckout))
  ) {
    return false;
  }
  if (!existsSync(resolved)) return true;
  const metadata = lstatSync(resolved);
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) return false;
  try {
    return readFileSync(path.join(resolved, STATE_OWNERSHIP_MARKER), "utf8") === STATE_OWNERSHIP_CONTENT;
  } catch {
    try {
      const manifest = JSON.parse(readFileSync(path.join(resolved, "setup-manifest.json"), "utf8"));
      return manifest.version === 1 && manifest.hooks && typeof manifest.hooks === "object";
    } catch {
      return false;
    }
  }
}

async function daemonRunning() {
  try {
    const response = await fetch(`${getRuntimeConfig().baseUrl}/api/v1/health`, {
      signal: AbortSignal.timeout(500),
    });
    return response.ok;
  } catch {
    return false;
  }
}

async function main() {
  if (args.has("--help")) {
    process.stdout.write(usage());
    return;
  }
  const unknown = rawArgs.find((argument) => !allowedArgs.has(argument));
  if (unknown) throw new Error(`Unknown option: ${unknown}\n\n${usage()}`);
  if (purge && !safePurgeTarget(paths.stateHome)) {
    throw new Error(`Refusing to purge an unowned or unsafe state path: ${paths.stateHome}`);
  }
  if (purge && !dryRun && (await daemonRunning())) {
    throw new Error("Quit the Switchboard desktop pane and daemon before using --purge; nothing was removed.");
  }
  process.stdout.write(`Agent Switchboard uninstall${dryRun ? " (dry run)" : ""}\n`);

  process.stdout.write("\nHarness integrations\n");
  const hooks = uninstallHarnessHooks({ dryRun });
  if (hooks.integrations.length === 0) process.stdout.write("  managed Codex/Claude hooks: not installed\n");
  for (const integration of hooks.integrations) {
    if (integration.error) {
      process.stdout.write(`  ${integration.harness}: preserved (${integration.error})\n`);
      continue;
    }
    const suffix = integration.preserved
      ? `; preserved ${integration.preserved} modified entr${integration.preserved === 1 ? "y" : "ies"}`
      : "";
    process.stdout.write(
      `  ${integration.harness}: ${dryRun ? "would remove" : "removed"} ${integration.removed} managed hook entr${integration.removed === 1 ? "y" : "ies"}${suffix}\n`,
    );
  }
  removeOwnedFile(
    "OpenCode plugin",
    paths.openCodePlugin,
    (content) => content.startsWith("// Generated by the Agent Switchboard OpenCode installer."),
  );

  process.stdout.write("\nDesktop integration\n");
  removeOwnedFile("application launcher", paths.desktopLauncher, desktopEntryOwned);
  removeOwnedFile("login autostart", paths.autostartLauncher, desktopEntryOwned);
  removeGnomeExtension();
  removeTmuxEnvironmentMarker();

  if (purge) {
    process.stdout.write("\nRuntime data\n");
    if (existsSync(paths.stateHome)) {
      if (!dryRun) rmSync(paths.stateHome, { recursive: true, force: true });
      process.stdout.write(`  ${dryRun ? "would remove" : "removed"} ${paths.stateHome}\n`);
    } else {
      process.stdout.write("  no runtime data found\n");
    }
  } else {
    process.stdout.write(`\nRuntime data was preserved at ${paths.stateHome}. Use --purge after stopping Switchboard to remove it.\n`);
  }

  process.stdout.write("Uninstall complete. A GNOME logout may be needed to unload a connector cached by the current Shell session.\n");
}

main().catch((error) => {
  process.stderr.write(`Uninstall stopped safely: ${error.message}\n`);
  process.exitCode = 1;
});
