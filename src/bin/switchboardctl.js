#!/usr/bin/env node

import { accessSync, constants } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { translateHarnessEvent } from "../adapters/index.js";
import { SwitchboardClient } from "../client.js";
import { ensureRuntimeHome, getRuntimeConfig } from "../config.js";
import { EVENT_KINDS, HARNESSES } from "../domain.js";
import { findHarnessAncestor } from "../discovery/linux.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

function usage() {
  return `Agent Switchboard control client

Usage:
  switchboardctl doctor
  switchboardctl list [--json]
  switchboardctl emit --harness <codex|claude|opencode> [--strict]
  switchboardctl event --harness <name> --session <id> --kind <kind> [options]
  switchboardctl demo [--clear]
  switchboardctl seen|unread|dismiss <session-id>
  switchboardctl integrations

The emit command reads one native hook event as JSON from stdin. It is silent and
non-blocking by default so a stopped daemon never interferes with an agent session.
`;
}

function option(args, name, fallback = null) {
  const index = args.indexOf(name);
  return index >= 0 && index + 1 < args.length ? args[index + 1] : fallback;
}

async function readStdin(maxBytes = 512 * 1024) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of process.stdin) {
    bytes += chunk.length;
    if (bytes > maxBytes) throw new Error("Hook event exceeded the 512 KiB safety limit");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function commandOnPath(name) {
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

function printSessionList(snapshot) {
  if (!snapshot.sessions.length) {
    process.stdout.write("No active or recent sessions.\n");
    return;
  }
  const stateWidth = Math.max(7, ...snapshot.sessions.map((session) => session.primaryState.length));
  const harnessWidth = Math.max(7, ...snapshot.sessions.map((session) => session.harness.length));
  for (const session of snapshot.sessions) {
    const state = session.primaryState.replaceAll("_", " ").padEnd(stateWidth + 1);
    const harness = session.harness.padEnd(harnessWidth + 1);
    process.stdout.write(`${state} ${harness} ${session.title}${session.project ? `  [${session.project}]` : ""}\n`);
  }
}

async function emitHook(args) {
  const harness = option(args, "--harness");
  const strict = args.includes("--strict");
  try {
    if (!HARNESSES.includes(harness)) throw new Error("--harness must be codex, claude, or opencode");
    const input = await readStdin();
    const raw = JSON.parse(input || "{}");
    const ancestor = findHarnessAncestor(harness) || {};
    const events = translateHarnessEvent(harness, raw, ancestor);
    if (!events.length) return;
    const config = getRuntimeConfig();
    const client = new SwitchboardClient(config);
    await client.emit(events, { timeoutMs: 450 });
  } catch (error) {
    if (strict || process.env.SWITCHBOARD_DEBUG) {
      process.stderr.write(`[switchboard hook] ${error.message}\n`);
      if (strict) process.exitCode = 1;
    }
  }
}

function normalizedEventFromArgs(args) {
  const harness = option(args, "--harness");
  const nativeSessionId = option(args, "--session");
  const kind = option(args, "--kind");
  if (!HARNESSES.includes(harness)) throw new Error("--harness must be codex, claude, or opencode");
  if (!nativeSessionId) throw new Error("--session is required");
  if (!Object.values(EVENT_KINDS).includes(kind)) throw new Error(`Unsupported --kind: ${kind}`);
  const summary = option(args, "--summary");
  return {
    eventId: randomUUID(),
    harness,
    nativeSessionId,
    kind,
    nativeType: option(args, "--native-type", "manual.event"),
    humanInitiated: args.includes("--human"),
    telemetry: "native",
    metadata: {
      title: option(args, "--title"),
      cwd: option(args, "--cwd"),
      branch: option(args, "--branch"),
    },
    attention: {
      kind: option(args, "--attention-kind", "input"),
      summary,
    },
    error: { kind: option(args, "--error-kind", "manual_error"), summary },
    completion: { outcome: args.includes("--failed") ? "failed" : "completed", summary },
  };
}

function demoEvents() {
  const now = Date.now();
  const definitions = [
    ["codex", "demo-codex-working", EVENT_KINDS.SESSION_STARTED, "Session monitor", "/workspace/session-monitor"],
    ["codex", "demo-codex-working", EVENT_KINDS.WORK_STARTED, "Session monitor", "/workspace/session-monitor"],
    ["claude", "demo-claude-attention", EVENT_KINDS.SESSION_STARTED, "Payments API", "/workspace/payments-api"],
    ["claude", "demo-claude-attention", EVENT_KINDS.WORK_STARTED, "Payments API", "/workspace/payments-api"],
    ["claude", "demo-claude-attention", EVENT_KINDS.ATTENTION_REQUESTED, "Payments API", "/workspace/payments-api"],
    ["opencode", "demo-opencode-unread", EVENT_KINDS.SESSION_STARTED, "Worker queue", "/workspace/worker"],
    ["opencode", "demo-opencode-unread", EVENT_KINDS.WORK_STARTED, "Worker queue", "/workspace/worker"],
    ["opencode", "demo-opencode-unread", EVENT_KINDS.WORK_COMPLETED, "Worker queue", "/workspace/worker"],
    ["codex", "demo-codex-error", EVENT_KINDS.SESSION_STARTED, "Web client", "/workspace/web-client"],
    ["codex", "demo-codex-error", EVENT_KINDS.SESSION_ERROR, "Web client", "/workspace/web-client"],
    ["claude", "demo-claude-idle", EVENT_KINDS.SESSION_STARTED, "Auth service", "/workspace/auth-service"],
  ];
  return definitions.map(([harness, nativeSessionId, kind, title, cwd], index) => ({
    eventId: `demo:${now}:${index}`,
    harness,
    nativeSessionId,
    kind,
    nativeType: `demo.${kind}`,
    occurredAt: now + index,
    telemetry: "native",
    metadata: { title, cwd, branch: index % 2 ? "feature/switchboard" : "main" },
    attention:
      kind === EVENT_KINDS.ATTENTION_REQUESTED
        ? { kind: "approval", requestId: "demo-request", summary: "Approval requested for Bash" }
        : undefined,
    error:
      kind === EVENT_KINDS.SESSION_ERROR
        ? { kind: "connection_failed", summary: "The model connection closed before the turn completed" }
        : undefined,
    completion:
      kind === EVENT_KINDS.WORK_COMPLETED
        ? { outcome: "completed", summary: "OpenCode finished the implementation" }
        : undefined,
  }));
}

async function doctor() {
  const config = getRuntimeConfig();
  ensureRuntimeHome(config);
  const rows = [];
  rows.push(["Runtime", Number(process.versions.node.split(".")[0]) >= 22 ? "ready" : "unsupported", `Node ${process.versions.node}`]);
  rows.push(["Platform", process.platform === "linux" ? "ready" : "limited", `${process.platform}/${process.arch}`]);
  for (const harness of HARNESSES) {
    const executable = commandOnPath(harness === "claude" ? "claude" : harness);
    rows.push([harness, executable ? "found" : "not found", executable || "Install or add it to PATH"]);
  }
  try {
    const health = await new SwitchboardClient(config).health();
    rows.push(["Daemon", "ready", `${config.baseUrl} · v${health.version}`]);
  } catch (error) {
    rows.push(["Daemon", "offline", `${config.baseUrl} · ${error.message}`]);
  }
  rows.push(["State", "ready", config.home]);

  const labelWidth = Math.max(...rows.map(([label]) => label.length));
  const stateWidth = Math.max(...rows.map(([, status]) => status.length));
  for (const [label, status, detail] of rows) {
    process.stdout.write(`${label.padEnd(labelWidth)}  ${status.padEnd(stateWidth)}  ${detail}\n`);
  }
}

function printIntegrations() {
  process.stdout.write(`Native integration templates\n\n`);
  process.stdout.write(`Codex:      ${path.join(ROOT, "integrations/codex/hooks.json")}\n`);
  process.stdout.write(`Claude Code:${path.join(ROOT, "integrations/claude/settings.json")}\n`);
  process.stdout.write(`OpenCode:   ${path.join(ROOT, "integrations/opencode/switchboard.js")}\n\n`);
  process.stdout.write(`See ${path.join(ROOT, "integrations/README.md")} for safe merge instructions.\n`);
}

async function main() {
  const args = process.argv.slice(2);
  const command = args[0];
  const config = getRuntimeConfig();
  const client = new SwitchboardClient(config);

  if (!command || ["-h", "--help", "help"].includes(command)) {
    process.stdout.write(usage());
    return;
  }
  if (command === "emit") {
    await emitHook(args.slice(1));
    return;
  }
  if (command === "doctor") {
    await doctor();
    return;
  }
  if (command === "integrations") {
    printIntegrations();
    return;
  }
  if (command === "list") {
    const snapshot = await client.sessions();
    if (args.includes("--json")) process.stdout.write(`${JSON.stringify(snapshot, null, 2)}\n`);
    else printSessionList(snapshot);
    return;
  }
  if (command === "event") {
    const event = normalizedEventFromArgs(args.slice(1));
    process.stdout.write(`${JSON.stringify(await client.emit(event), null, 2)}\n`);
    return;
  }
  if (command === "demo") {
    if (args.includes("--clear")) {
      const result = await client.clearDemoData();
      process.stdout.write(`Removed ${result.sessions} demo sessions and ${result.events} demo events.\n`);
      return;
    }
    const result = await client.emit(demoEvents());
    process.stdout.write(`Loaded demo traffic for ${result.accepted} events. Open ${config.baseUrl}\n`);
    return;
  }
  if (["seen", "unread", "dismiss"].includes(command)) {
    const id = args[1];
    if (!id) throw new Error(`${command} requires a session id`);
    const result = await client.action(id, command);
    process.stdout.write(`${result.session.title}: ${result.session.primaryState}\n`);
    return;
  }

  throw new Error(`Unknown command: ${command}\n\n${usage()}`);
}

main().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
