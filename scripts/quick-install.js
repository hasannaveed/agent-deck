#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ALLOWED_OPTIONS = new Set([
  "--autostart",
  "--dry-run",
  "--help",
  "--no-autostart",
  "--no-launch",
  "--skip-dependencies",
  "--skip-gnome",
  "--skip-hooks",
]);

export function quickInstallUsage() {
  return `Agent Switchboard quick installer

Usage:
  ./install.sh [options]
  npm run install:user -- [options]

The default installation downloads locked npm dependencies, safely installs the
harness and desktop integrations, enables desktop autostart, runs diagnostics,
and opens Agent Switchboard.

Options:
  --no-autostart        do not start Agent Switchboard automatically at login
  --no-launch           install everything without opening the desktop pane now
  --skip-dependencies   reuse the dependencies already in node_modules
  --skip-gnome          do not install the optional GNOME desktop connector
  --skip-hooks          do not install Codex, Claude Code, or OpenCode events
  --dry-run             preview managed destinations without changing anything
  --help                show this help
`;
}

export function runtimeSupported(version = process.versions.node) {
  const match = String(version).match(/^(\d+)\.(\d+)(?:\.|$)/);
  if (!match) return false;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  return major > 22 || (major === 22 && minor >= 5);
}

export function parseQuickInstallArgs(argv = []) {
  const unknown = argv.find((argument) => !ALLOWED_OPTIONS.has(argument));
  if (unknown) throw new Error(`Unknown option: ${unknown}\n\n${quickInstallUsage()}`);

  const flags = new Set(argv);
  if (flags.has("--autostart") && flags.has("--no-autostart")) {
    throw new Error("Choose either --autostart or --no-autostart, not both.");
  }

  return {
    help: flags.has("--help"),
    dryRun: flags.has("--dry-run"),
    autostart: !flags.has("--no-autostart"),
    noLaunch: flags.has("--no-launch"),
    skipDependencies: flags.has("--skip-dependencies"),
    skipGnome: flags.has("--skip-gnome"),
    skipHooks: flags.has("--skip-hooks"),
  };
}

export function createQuickInstallPlan(options) {
  const setupArgs = [];
  if (options.autostart) setupArgs.push("--autostart");
  if (options.dryRun) setupArgs.push("--dry-run");
  if (options.noLaunch) setupArgs.push("--no-launch");
  if (options.skipGnome) setupArgs.push("--skip-gnome");
  if (options.skipHooks) setupArgs.push("--skip-hooks");

  return {
    installDependencies: !options.dryRun && !options.skipDependencies,
    dependencyArgs: ["ci", "--no-audit", "--no-fund"],
    setupArgs,
  };
}

function run(file, args, label) {
  const result = spawnSync(file, args, {
    cwd: ROOT,
    env: process.env,
    stdio: "inherit",
  });
  if (result.error) throw new Error(`${label} could not start: ${result.error.message}`);
  if (result.status !== 0) {
    throw new Error(`${label} failed${Number.isInteger(result.status) ? ` with status ${result.status}` : ""}.`);
  }
}

function printHeading(label) {
  process.stdout.write(`\n==> ${label}\n`);
}

export function runQuickInstall(options, { platform = process.platform } = {}) {
  if (platform !== "linux") {
    throw new Error(`Agent Switchboard currently supports Linux; detected ${platform}.`);
  }
  if (!runtimeSupported()) {
    throw new Error(`Node.js 22.5 or newer is required; found ${process.versions.node}.`);
  }

  const plan = createQuickInstallPlan(options);
  process.stdout.write("Agent Switchboard one-command installer\n");
  process.stdout.write(`Checkout: ${ROOT}\n`);

  if (plan.installDependencies) {
    printHeading("Installing locked dependencies");
    const npm = process.platform === "win32" ? "npm.cmd" : "npm";
    run(npm, plan.dependencyArgs, "Dependency installation");
  } else if (options.dryRun) {
    printHeading("Dependencies");
    process.stdout.write("  dry run: npm dependencies would be installed\n");
  } else {
    printHeading("Dependencies");
    process.stdout.write("  using the existing node_modules directory\n");
  }

  printHeading(options.dryRun ? "Previewing user integration setup" : "Installing user integrations");
  run(process.execPath, [path.join(ROOT, "scripts", "setup.js"), ...plan.setupArgs], "User integration setup");

  if (options.dryRun) {
    process.stdout.write("\nPreview complete. Run ./install.sh to install Agent Switchboard.\n");
    return;
  }

  process.stdout.write("\nAgent Switchboard is installed.\n");
  if (options.autostart) process.stdout.write("It will start automatically when you sign in.\n");
  if (options.noLaunch) process.stdout.write("Start it with npm run gui or from the application menu.\n");
  process.stdout.write("Check the installation at any time with npm run doctor.\n");
  process.stdout.write("Remove managed integrations with npm run uninstall.\n");
}

async function main() {
  const options = parseQuickInstallArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(quickInstallUsage());
    return;
  }
  runQuickInstall(options);
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : null;
if (invokedPath === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`Installation stopped safely: ${error.message}\n`);
    process.exitCode = 1;
  });
}
