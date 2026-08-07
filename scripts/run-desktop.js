#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { desktopLaunchArguments } from "../desktop/windowing.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const electron = require("electron");
const args = desktopLaunchArguments({
  appPath: ROOT,
  argv: process.argv.slice(2),
});

const child = spawn(electron, args, {
  cwd: ROOT,
  env: process.env,
  stdio: "inherit",
});

child.on("error", (error) => {
  process.stderr.write(`Could not start Agent Switchboard: ${error.message}\n`);
  process.exitCode = 1;
});
child.on("exit", (code) => {
  process.exitCode = code ?? 0;
});
