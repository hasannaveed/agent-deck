#!/usr/bin/env node

import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const JAVASCRIPT_ROOTS = ["src", "web", "desktop", "integrations", "test", "scripts"];
const JSON_FILES = [
  "package.json",
  "web/manifest.webmanifest",
  "integrations/codex/hooks.json",
  "integrations/claude/settings.json",
];

function filesBelow(directory) {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const location = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...filesBelow(location));
    else if (entry.isFile() && location.endsWith(".js")) files.push(location);
  }
  return files;
}

for (const relativeRoot of JAVASCRIPT_ROOTS) {
  for (const file of filesBelow(path.join(ROOT, relativeRoot))) {
    const result = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
    if (result.status !== 0) {
      process.stderr.write(result.stderr || result.stdout);
      process.exit(result.status || 1);
    }
  }
}

for (const file of JSON_FILES) JSON.parse(readFileSync(path.join(ROOT, file), "utf8"));
process.stdout.write("Syntax and JSON checks passed.\n");

const tests = spawnSync(process.execPath, ["--test"], { cwd: ROOT, stdio: "inherit" });
process.exit(tests.status || 0);
