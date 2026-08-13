import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fstatSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  readlinkSync,
} from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  displayHarness,
  EVENT_KINDS,
  PROCESS_START_TOLERANCE_MS,
} from "../domain.js";
import {
  isVisualStudioCodeCodexProcess,
  visualStudioCodeHostFrom,
} from "../vscode.js";

const CPU_TICKS_PER_SECOND = 100;
// Full-screen TUIs animate even while idle, so activity must rise clearly above
// that background churn before Switchboard labels a process as working.
const ACTIVE_CPU_FRACTION = 0.08;
const ACTIVE_IO_CHARS_PER_SECOND = 32 * 1024;
const CODEX_ROLLOUT_PREFIX_BYTES = 64 * 1024;
const CODEX_ROLLOUT_TAIL_BYTES = 512 * 1024;
const CODEX_ROLLOUT_FILE = /(?:^|\/)rollout-[^/]*-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;
export const NESTED_HARNESS_ENV = "AGENT_SWITCHBOARD_CHILD";

function safeRead(file, encoding = "utf8") {
  try {
    return readFileSync(file, encoding);
  } catch {
    return null;
  }
}

function safeReadlink(file) {
  try {
    return readlinkSync(file);
  } catch {
    return null;
  }
}

function safeReadRange(file, start, length) {
  let descriptor;
  try {
    descriptor = openSync(file, "r");
    const size = fstatSync(descriptor).size;
    const position = Math.max(0, Math.min(size, start < 0 ? size + start : start));
    const available = Math.max(0, Math.min(length, size - position));
    const buffer = Buffer.allocUnsafe(available);
    const bytesRead = available ? readSync(descriptor, buffer, 0, available, position) : 0;
    return { text: buffer.subarray(0, bytesRead).toString("utf8"), position, size };
  } catch {
    return null;
  } finally {
    if (descriptor !== undefined) {
      try {
        closeSync(descriptor);
      } catch {}
    }
  }
}

// Codex records lifecycle events in its rollout JSONL. Read only a bounded
// prefix (to reject subagent rollouts) and tail, and only parse short lifecycle
// lines. Prompt, reasoning, tool, and assistant content never leave this helper.
export function readCodexRolloutLifecycle(file) {
  const match = String(file || "").match(CODEX_ROLLOUT_FILE);
  if (!match) return null;
  const prefix = safeReadRange(file, 0, CODEX_ROLLOUT_PREFIX_BYTES);
  if (!prefix || !/"type"\s*:\s*"session_meta"/.test(prefix.text)) return null;
  if (
    /"thread_source"\s*:\s*"subagent"/.test(prefix.text) ||
    /"source"\s*:\s*\{\s*"subagent"/.test(prefix.text)
  ) {
    return null;
  }

  const result = { sessionId: match[1].toLowerCase(), lifecycle: null };
  const tail = safeReadRange(file, -CODEX_ROLLOUT_TAIL_BYTES, CODEX_ROLLOUT_TAIL_BYTES);
  if (!tail) return result;
  let lines = tail.text.split(/\r?\n/);
  if (tail.position > 0) lines = lines.slice(1);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index];
    if (
      !/"type"\s*:\s*"event_msg"/.test(line) ||
      !/"type"\s*:\s*"(?:task_started|task_complete|turn_aborted)"/.test(line)
    ) {
      continue;
    }
    try {
      const record = JSON.parse(line);
      const payload = record?.payload;
      if (record?.type !== "event_msg" || !payload || typeof payload !== "object") continue;
      if (!["task_started", "task_complete", "turn_aborted"].includes(payload.type)) continue;
      if (payload.type === "turn_aborted" && payload.reason !== "interrupted") continue;
      const occurredAt = Date.parse(record.timestamp || payload.completed_at || payload.started_at);
      if (!Number.isFinite(occurredAt) || typeof payload.turn_id !== "string") continue;
      result.lifecycle = {
        type: payload.type,
        turnId: payload.turn_id,
        occurredAt,
      };
      break;
    } catch {
      // The file may be mid-write. A complete lifecycle line will be picked up
      // on the next discovery pass.
    }
  }
  return result;
}

export function readCodexProcessLifecycle(processInfo) {
  if (processInfo?.harness !== "codex" || !Number.isInteger(processInfo.pid)) return null;
  let descriptors;
  try {
    descriptors = readdirSync(`/proc/${processInfo.pid}/fd`);
  } catch {
    return null;
  }
  const candidates = [];
  const paths = new Set();
  for (const descriptor of descriptors) {
    const target = safeReadlink(`/proc/${processInfo.pid}/fd/${descriptor}`);
    if (!target || paths.has(target) || !CODEX_ROLLOUT_FILE.test(target)) continue;
    paths.add(target);
    const candidate = readCodexRolloutLifecycle(target);
    if (candidate) candidates.push(candidate);
  }
  return candidates.sort(
    (left, right) => (right.lifecycle?.occurredAt || 0) - (left.lifecycle?.occurredAt || 0),
  )[0] || null;
}

function basename(value) {
  return value ? path.basename(value).toLowerCase() : "";
}

export function detectHarnessProcess(processInfo) {
  const comm = processInfo.comm.toLowerCase();
  const command = basename(processInfo.argv[0]);
  const script = processInfo.argv[1] || "";

  if (comm === "codex" || command === "codex") return "codex";
  if (["node", "bun"].includes(command) && /(?:^|[/\\])@openai[/\\]codex(?:[/\\]|$)/i.test(script)) return "codex";
  if (comm === "claude" || command === "claude") return "claude";
  if (["node", "bun"].includes(command) && /(?:^|[/\\])@anthropic-ai[/\\]claude-code(?:[/\\]|$)/i.test(script)) return "claude";
  if (comm === "opencode" || command === "opencode") return "opencode";
  return null;
}

function parseStat(stat) {
  if (!stat) return null;
  const closingParen = stat.lastIndexOf(")");
  if (closingParen < 0) return null;
  const fields = stat.slice(closingParen + 1).trim().split(/\s+/);
  return {
    state: fields[0] || null,
    parentPid: Number.parseInt(fields[1], 10) || 0,
    processGroup: Number.parseInt(fields[2], 10) || 0,
    sessionId: Number.parseInt(fields[3], 10) || 0,
    foregroundProcessGroup: Number.parseInt(fields[5], 10) || 0,
    cpuTicks: (Number.parseInt(fields[11], 10) || 0) + (Number.parseInt(fields[12], 10) || 0),
    startTicks: Number.parseInt(fields[19], 10) || 0,
  };
}

function parseIoCounters(value) {
  if (!value) return null;
  let characters = 0;
  let found = 0;
  for (const line of value.split("\n")) {
    const match = line.match(/^(?:rchar|wchar):\s+(\d+)$/);
    if (!match) continue;
    characters += Number(match[1]);
    found += 1;
  }
  return found === 2 && Number.isSafeInteger(characters) ? characters : null;
}

function parseEnvironment(buffer) {
  const values = new Map();
  if (!buffer) return values;
  for (const entry of buffer.toString("utf8").split("\0")) {
    const separator = entry.indexOf("=");
    if (separator > 0) values.set(entry.slice(0, separator), entry.slice(separator + 1));
  }
  return values;
}

export function gnomeTerminalLocatorFrom(processInfo) {
  const env = processInfo.environment;
  if (!env.get("GNOME_TERMINAL_SCREEN") || !env.get("GNOME_TERMINAL_SERVICE")) return null;
  const tty = processInfo.tty?.startsWith("/dev/") ? processInfo.tty.slice(5) : processInfo.tty || null;
  return {
    label: `GNOME Terminal${tty ? ` · ${tty}` : ""}`,
    kind: "gnome-terminal",
    target: env.get("GNOME_TERMINAL_SCREEN"),
    instance: env.get("GNOME_TERMINAL_SERVICE"),
  };
}

export function terminalLocatorFrom(processInfo) {
  const env = processInfo.environment;
  if (env.get("TMUX") && env.get("TMUX_PANE")) {
    return {
      label: `tmux ${env.get("TMUX_PANE")}`,
      kind: "tmux",
      target: env.get("TMUX_PANE"),
      instance: env.get("TMUX").split(",")[0] || null,
    };
  }
  if (env.get("WEZTERM_PANE")) {
    return {
      label: `wezterm pane ${env.get("WEZTERM_PANE")}`,
      kind: "wezterm",
      target: env.get("WEZTERM_PANE"),
      instance: env.get("WEZTERM_UNIX_SOCKET") || null,
    };
  }
  if (env.get("KITTY_WINDOW_ID")) {
    return {
      label: `kitty window ${env.get("KITTY_WINDOW_ID")}`,
      kind: "kitty",
      target: env.get("KITTY_WINDOW_ID"),
      instance: env.get("KITTY_LISTEN_ON") || null,
    };
  }
  if (env.get("ZELLIJ")) {
    const session = env.get("ZELLIJ_SESSION_NAME") || null;
    return {
      label: `zellij${session ? ` ${session}` : env.get("ZELLIJ_PANE_ID") ? ` ${env.get("ZELLIJ_PANE_ID")}` : ""}`,
      kind: session ? "zellij" : null,
      target: session,
      instance: null,
    };
  }
  const gnomeTerminal = gnomeTerminalLocatorFrom(processInfo);
  if (gnomeTerminal) return gnomeTerminal;
  if (env.get("TERM_PROGRAM")) return { label: env.get("TERM_PROGRAM"), kind: null, target: null, instance: null };
  const tty = processInfo.tty?.startsWith("/dev/") ? processInfo.tty.slice(5) : processInfo.tty || null;
  return { label: tty, kind: null, target: null, instance: null };
}

export function readTerminalTitle(processInfo, execute = execFileSync) {
  if (processInfo.terminalKind !== "tmux" || !/^%\d{1,12}$/.test(processInfo.terminalTarget || "")) {
    return null;
  }
  if (
    processInfo.terminalInstance &&
    (!path.isAbsolute(processInfo.terminalInstance) || processInfo.terminalInstance.length > 2048)
  ) {
    return null;
  }

  const args = processInfo.terminalInstance ? ["-S", processInfo.terminalInstance] : [];
  args.push("display-message", "-p", "-t", processInfo.terminalTarget, "#{pane_title}");
  try {
    const output = execute("tmux", args, {
      encoding: "utf8",
      timeout: 350,
      stdio: ["ignore", "pipe", "ignore"],
    });
    return String(output).replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, 160) || null;
  } catch {
    return null;
  }
}

export function hasNestedHarnessMarker(processInfo) {
  return processInfo.environment?.get(NESTED_HARNESS_ENV) === "1";
}

export function activityHintFromTerminalTitle(harness, title) {
  if (!title || harness !== "codex") return null;
  if (/\bAction Required\b/i.test(title)) return "needs_attention";
  if (/^[\u2801-\u28ff]/u.test(title)) return "working";
  return "idle";
}

function openCodeDatabasePath(processInfo) {
  const dataHome = processInfo.environment?.get("XDG_DATA_HOME");
  const root = dataHome && path.isAbsolute(dataHome) ? dataHome : path.join(homedir(), ".local", "share");
  return path.join(root, "opencode", "opencode.db");
}

export function readOpenCodeActivityHint(processInfo, options = {}) {
  if (processInfo.harness !== "opencode" || !processInfo.cwd) return null;
  const databasePath = options.databasePath || openCodeDatabasePath(processInfo);
  if (!options.database && !existsSync(databasePath)) return null;

  const ownsDatabase = !options.database;
  let database;
  try {
    database = options.database || new DatabaseSync(databasePath, { readOnly: true });
    const paneSessionTitle = processInfo.terminalTitle?.match(/^OC\s*\|\s*(.+)$/i)?.[1]?.trim() || null;
    const session = database
      .prepare(
        `SELECT id FROM session
         WHERE directory = ? AND time_archived IS NULL
         ORDER BY CASE WHEN title = ? THEN 0 ELSE 1 END, time_updated DESC
         LIMIT 1`,
      )
      .get(processInfo.cwd, paneSessionTitle);
    if (!session) return null;

    const assistant = database
      .prepare(
        `SELECT id,
                json_extract(data, '$.time.completed') AS completed
         FROM message
         WHERE session_id = ? AND json_extract(data, '$.role') = 'assistant'
         ORDER BY time_created DESC LIMIT 1`,
      )
      .get(session.id);
    if (!assistant) return "idle";

    const tool = database
      .prepare(
        `SELECT json_extract(data, '$.state.status') AS status
         FROM part
         WHERE message_id = ?
           AND json_extract(data, '$.type') = 'tool'
           AND json_extract(data, '$.state.status') IN ('pending', 'running')
         ORDER BY time_updated DESC LIMIT 1`,
      )
      .get(assistant.id);
    if (["pending", "running"].includes(tool?.status)) return "working";
    return assistant.completed === null ? "working" : "idle";
  } catch {
    return null;
  } finally {
    if (ownsDatabase) database?.close();
  }
}

export function readProcessInfo(pid) {
  const root = `/proc/${pid}`;
  const comm = safeRead(`${root}/comm`)?.trim();
  const commandLine = safeRead(`${root}/cmdline`, null);
  const stat = parseStat(safeRead(`${root}/stat`));
  if (!comm || !commandLine || !stat) return null;
  const argv = commandLine.toString("utf8").split("\0").filter(Boolean);
  const environment = parseEnvironment(safeRead(`${root}/environ`, null));
  const info = {
    pid: Number(pid),
    comm,
    argv,
    state: stat.state,
    parentPid: stat.parentPid,
    processGroup: stat.processGroup,
    sessionId: stat.sessionId,
    foregroundProcessGroup: stat.foregroundProcessGroup,
    cpuTicks: stat.cpuTicks,
    ioChars: parseIoCounters(safeRead(`${root}/io`)),
    startTicks: stat.startTicks,
    cwd: safeReadlink(`${root}/cwd`),
    tty: safeReadlink(`${root}/fd/0`),
    environment,
  };
  info.harness = detectHarnessProcess(info);
  const terminal = terminalLocatorFrom(info);
  const hostTerminal = gnomeTerminalLocatorFrom(info);
  info.terminal = terminal.label;
  info.terminalKind = terminal.kind;
  info.terminalTarget = terminal.target;
  info.terminalInstance = terminal.instance;
  if (terminal.kind !== "gnome-terminal" && hostTerminal) {
    info.hostTerminalKind = hostTerminal.kind;
    info.hostTerminalTarget = hostTerminal.target;
    info.hostTerminalInstance = hostTerminal.instance;
  }
  return info;
}

export function isNestedHarnessProcess(processInfo, read = readProcessInfo) {
  if (!processInfo?.harness) return false;
  if (hasNestedHarnessMarker(processInfo)) return true;

  const visited = new Set([processInfo.pid]);
  let pid = processInfo.parentPid;
  for (let depth = 0; depth < 16 && pid > 1 && !visited.has(pid); depth += 1) {
    visited.add(pid);
    const ancestor = read(pid);
    if (!ancestor) return false;
    if (ancestor.harness) return true;
    pid = ancestor.parentPid;
  }
  return false;
}

export function isInteractiveHarnessProcess(processInfo) {
  if (!processInfo?.harness) return false;
  if (["T", "t", "Z", "X", "x"].includes(processInfo.state)) return false;
  if (isVisualStudioCodeCodexProcess(processInfo)) return true;
  if (!processInfo.tty?.startsWith("/dev/")) return false;
  return (
    processInfo.processGroup > 0 &&
    processInfo.foregroundProcessGroup > 0 &&
    processInfo.processGroup === processInfo.foregroundProcessGroup
  );
}

export function processActivitySample(previous, current, elapsedMs) {
  if (!previous || !current || !Number.isFinite(elapsedMs) || elapsedMs <= 0) return null;
  const elapsedSeconds = elapsedMs / 1000;
  let comparable = false;

  if (Number.isFinite(previous.cpuTicks) && Number.isFinite(current.cpuTicks)) {
    comparable = true;
    const tickDelta = Math.max(0, current.cpuTicks - previous.cpuTicks);
    const cpuFraction = tickDelta / (elapsedSeconds * CPU_TICKS_PER_SECOND);
    if (cpuFraction >= ACTIVE_CPU_FRACTION) return "active";
  }

  if (Number.isFinite(previous.ioChars) && Number.isFinite(current.ioChars)) {
    comparable = true;
    const characterDelta = Math.max(0, current.ioChars - previous.ioChars);
    if (characterDelta / elapsedSeconds >= ACTIVE_IO_CHARS_PER_SECOND) return "active";
  }

  return comparable ? "quiet" : null;
}

function sameProcessIncarnation(session, item) {
  if (!session || !item || session.harness !== item.harness || session.pid !== item.pid) return false;
  if (session.nativeSessionId === item.nativeSessionId) return true;
  const sessionStartedAt = Number(session.startedAt);
  const processStartedAt = Number(item.startedAt);
  return (
    Number.isFinite(sessionStartedAt) &&
    Number.isFinite(processStartedAt) &&
    Math.abs(sessionStartedAt - processStartedAt) <= PROCESS_START_TOLERANCE_MS
  );
}

function approximateStartTime(startTicks) {
  const uptime = Number.parseFloat(safeRead("/proc/uptime")?.split(" ")[0] || "0");
  if (!uptime || !startTicks) return Date.now();
  const processAgeSeconds = Math.max(0, uptime - startTicks / 100);
  return Date.now() - processAgeSeconds * 1000;
}

export function scanHarnessProcesses() {
  if (process.platform !== "linux") return [];
  const entries = readdirSync("/proc", { withFileTypes: true });
  const found = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^\d+$/.test(entry.name)) continue;
    const pid = Number(entry.name);
    if (pid === process.pid) continue;
    const info = readProcessInfo(pid);
    if (!isInteractiveHarnessProcess(info)) continue;
    if (isNestedHarnessProcess(info)) continue;
    const applicationHost = visualStudioCodeHostFrom(info, readProcessInfo);
    const project = info.cwd ? path.basename(info.cwd) : null;
    const terminalTitle = readTerminalTitle(info);
    const titleHint = activityHintFromTerminalTitle(info.harness, terminalTitle);
    // A VS Code app server may own several threads at once, so an arbitrary
    // open rollout file cannot safely identify that host process's one row.
    const codexRollout = applicationHost ? null : readCodexProcessLifecycle(info);
    found.push({
      ...info,
      processKey: `${info.harness}:${pid}:${info.startTicks}`,
      nativeSessionId: codexRollout?.sessionId || `process-${pid}-${info.startTicks}`,
      title: project ? `${project} · ${info.harness}` : `${info.harness} process ${pid}`,
      project,
      terminalTitle,
      codexRollout,
      hostApplication: applicationHost?.application || null,
      hostPid: applicationHost?.pid || null,
      activityHint:
        titleHint ||
        readOpenCodeActivityHint({
          ...info,
          terminalTitle,
        }),
      startedAt: approximateStartTime(info.startTicks),
    });
  }
  return found;
}

export function findHarnessAncestor(
  expectedHarness = null,
  startPid = process.ppid,
  read = readProcessInfo,
) {
  if (process.platform !== "linux") return null;
  const visited = new Set();
  let pid = startPid;
  for (let depth = 0; depth < 12 && pid > 1 && !visited.has(pid); depth += 1) {
    visited.add(pid);
    const info = read(pid);
    if (!info) return null;
    if (info.harness && (!expectedHarness || info.harness === expectedHarness)) {
      const applicationHost = visualStudioCodeHostFrom(info, read);
      return {
        pid: info.pid,
        cwd: info.cwd,
        terminal: info.terminal,
        terminalKind: info.terminalKind,
        terminalTarget: info.terminalTarget,
        terminalInstance: info.terminalInstance,
        hostTerminalKind: info.hostTerminalKind,
        hostTerminalTarget: info.hostTerminalTarget,
        hostTerminalInstance: info.hostTerminalInstance,
        hostApplication: applicationHost?.application || null,
        hostPid: applicationHost?.pid || null,
        startedAt: approximateStartTime(info.startTicks),
        nested: isNestedHarnessProcess(info, read),
      };
    }
    pid = info.parentPid;
  }
  return null;
}

export class LinuxProcessDiscovery {
  constructor({
    store,
    intervalMs = 2500,
    activityIdleMs = 7500,
    logger = console,
    scan = scanHarnessProcesses,
    now = Date.now,
    onProcessDiscovered = null,
  }) {
    this.store = store;
    this.intervalMs = intervalMs;
    this.activityIdleMs = Math.max(intervalMs * 2, activityIdleMs);
    this.logger = logger;
    this.scan = scan;
    this.now = now;
    this.onProcessDiscovered = onProcessDiscovered;
    this.known = new Map();
    this.activity = new Map();
    this.codexApprovalEvidence = new Map();
    this.instanceId = randomUUID();
    this.eventSequence = 0;
    this.initialized = false;
    this.timer = null;
  }

  notifyProcessDiscovered(item, occurredAt) {
    if (typeof this.onProcessDiscovered !== "function") return;
    try {
      Promise.resolve(this.onProcessDiscovered(item, occurredAt)).catch((error) => {
        this.logger.error?.(`[discovery] post-discovery action failed: ${error.message}`);
      });
    } catch (error) {
      this.logger.error?.(`[discovery] post-discovery action failed: ${error.message}`);
    }
  }

  eventId(key, transition) {
    this.eventSequence += 1;
    return `${this.instanceId}:${this.eventSequence}:${key}:${transition}`;
  }

  markGone(item, key) {
    const liveSessions = this.store
      .listLiveSessionsForPid(item.harness, item.pid)
      .filter((session) => sameProcessIncarnation(session, item));
    const targets = liveSessions.length ? liveSessions : [item];
    const occurredAt = this.now();
    for (const target of targets) {
      this.store.ingest({
        eventId: this.eventId(key, `gone:${target.nativeSessionId}`),
        harness: item.harness,
        nativeSessionId: target.nativeSessionId || item.nativeSessionId,
        kind: EVENT_KINDS.PROCESS_GONE,
        nativeType: "process.exited",
        occurredAt,
        telemetry: "process",
        confidence: 0.85,
        metadata: { pid: item.pid },
      });
    }
  }

  processSession(item) {
    const session = this.store
      .listLiveSessionsForPid(item.harness, item.pid)
      .find((candidate) => sameProcessIncarnation(candidate, item));
    return session || null;
  }

  emitInferredActivity(item, key, kind, nativeType, activity, occurredAt) {
    const session = this.processSession(item);
    if (session && session.telemetry !== "process") return false;
    if (
      session?.activity === activity &&
      !(activity === "working" && session.attention === "required")
    ) {
      return true;
    }
    const result = this.store.ingest({
      eventId: this.eventId(key, nativeType),
      harness: item.harness,
      nativeSessionId: session?.nativeSessionId || item.nativeSessionId,
      kind,
      nativeType: `process.activity.${nativeType}`,
      occurredAt,
      telemetry: "process",
      confidence: 0.6,
      metadata: { pid: item.pid },
    });
    return result.accepted || result.session?.activity === activity;
  }

  emitCodexRolloutLifecycle(item) {
    const signal = item.codexRollout?.lifecycle;
    const nativeSessionId = item.codexRollout?.sessionId;
    if (!signal || !nativeSessionId) return;
    const session = this.processSession(item);
    if (session && session.telemetry !== "process" && session.lastEventAt > signal.occurredAt) {
      const newerTurnStarted = [
        "UserPromptSubmit",
        "turn/started",
        "codex.rollout.task_started",
      ].includes(session.lastEventType);
      if (signal.type !== "turn_aborted" || newerTurnStarted) return;
    }

    let kind;
    if (signal.type === "task_started") kind = EVENT_KINDS.WORK_STARTED;
    else if (signal.type === "turn_aborted") kind = EVENT_KINDS.WORK_INTERRUPTED;
    else if (signal.type === "task_complete") {
      // If the human already opened this result, use the lifecycle record only
      // to clear a stale process-level Working state; do not recreate Unread.
      kind = session?.seenAt >= signal.occurredAt
        ? EVENT_KINDS.ACTIVITY_IDLE
        : EVENT_KINDS.WORK_COMPLETED;
    } else return;

    this.store.ingest({
      eventId: `${kind}:${signal.turnId}`,
      harness: "codex",
      nativeSessionId,
      kind,
      nativeType: `codex.rollout.${signal.type}`,
      occurredAt: signal.occurredAt,
      telemetry: "native",
      confidence: 1,
      humanInitiated: signal.type === "task_started",
      metadata: {
        cwd: item.cwd,
        project: item.project,
        pid: item.pid,
        terminal: item.terminal,
        terminalKind: item.terminalKind,
        terminalTarget: item.terminalTarget,
        terminalInstance: item.terminalInstance,
        hostApplication: item.hostApplication,
        hostPid: item.hostPid,
        startedAt: item.startedAt,
      },
      completion:
        signal.type === "task_complete"
          ? { outcome: "completed", summary: "Codex finished the turn" }
          : undefined,
    });
  }

  emitInferredAttention(item, key, occurredAt) {
    const session = this.processSession(item);
    if (session && session.telemetry !== "process") return false;
    if (session?.attention === "required") return true;
    const result = this.store.ingest({
      eventId: this.eventId(key, "needs-attention"),
      harness: item.harness,
      nativeSessionId: session?.nativeSessionId || item.nativeSessionId,
      kind: EVENT_KINDS.ATTENTION_REQUESTED,
      nativeType: "process.status.needs_attention",
      occurredAt,
      telemetry: "process",
      confidence: 0.75,
      metadata: { pid: item.pid },
      attention: {
        kind: "input",
        requestId: `process-${item.pid}`,
        summary: `${displayHarness(item.harness)} is waiting for input`,
      },
    });
    return result.accepted || result.session?.attention === "required";
  }

  clearInferredAttention(item, key, occurredAt) {
    const session = this.processSession(item);
    if (session && session.telemetry !== "process") return false;
    if (session?.attention !== "required") return true;
    const result = this.store.ingest({
      eventId: this.eventId(key, "attention-resolved"),
      harness: item.harness,
      nativeSessionId: session?.nativeSessionId || item.nativeSessionId,
      kind: EVENT_KINDS.ATTENTION_RESOLVED,
      nativeType: "process.status.attention_resolved",
      occurredAt,
      telemetry: "process",
      confidence: 0.7,
      metadata: { pid: item.pid },
    });
    return result.accepted || result.session?.attention !== "required";
  }

  updateCodexApprovalResolution(key, item, session, occurredAt) {
    const workingTitle =
      item.harness === "codex" &&
      item.terminalKind === "tmux" &&
      activityHintFromTerminalTitle("codex", item.terminalTitle) === "working";
    const pendingApproval =
      session?.presence === "live" &&
      session.attention === "required" &&
      session.attentionKind === "approval";
    if (!workingTitle || !pendingApproval) {
      this.codexApprovalEvidence.delete(key);
      return false;
    }

    // Tie the evidence to this exact attention event. A new permission prompt
    // restarts the debounce even if the pane title stays in its working state.
    const attentionEventAt = session.lastEventAt;
    const previous = this.codexApprovalEvidence.get(key);
    const scans = previous?.attentionEventAt === attentionEventAt ? previous.scans + 1 : 1;
    this.codexApprovalEvidence.set(key, { attentionEventAt, scans });
    if (scans < 2) return false;

    this.codexApprovalEvidence.delete(key);
    const result = this.store.ingest({
      eventId: this.eventId(key, `approval-resolved:${attentionEventAt}`),
      harness: "codex",
      nativeSessionId: session.nativeSessionId,
      kind: EVENT_KINDS.ATTENTION_RESOLVED,
      nativeType: "process.status.approval_resolved",
      occurredAt,
      telemetry: "process",
      confidence: 0.8,
      metadata: { pid: item.pid },
    });
    return result.accepted || result.session?.attention !== "required";
  }

  updateInferredActivity(key, previous, current, occurredAt) {
    const session = this.processSession(current);
    if (session && session.telemetry !== "process") {
      this.updateCodexApprovalResolution(key, current, session, occurredAt);
      this.activity.delete(key);
      return;
    }
    this.codexApprovalEvidence.delete(key);

    let observation = this.activity.get(key);
    if (!observation) {
      observation = {
        state:
          session?.attention === "required"
            ? "needs_attention"
            : ["working", "interrupted", "idle"].includes(session?.activity)
              ? session.activity
              : null,
        quietSince: null,
        sampledAt: occurredAt,
      };
      this.activity.set(key, observation);
    }

    const elapsedMs = occurredAt - observation.sampledAt;
    observation.sampledAt = occurredAt;
    if (current.activityHint === "needs_attention") {
      observation.quietSince = null;
      if (observation.state !== "needs_attention") {
        this.emitInferredAttention(current, key, occurredAt);
        observation.state = "needs_attention";
      }
      this.activity.set(key, observation);
      return;
    }
    if (current.activityHint === "working") {
      observation.quietSince = null;
      if (observation.state !== "working") {
        this.emitInferredActivity(
          current,
          key,
          EVENT_KINDS.WORK_STARTED,
          "working",
          "working",
          occurredAt,
        );
        observation.state = "working";
      }
      this.activity.set(key, observation);
      return;
    }
    if (current.activityHint === "idle") {
      observation.quietSince = null;
      if (observation.state !== "idle") {
        const completedWork = observation.state === "working";
        this.clearInferredAttention(current, key, occurredAt);
        this.emitInferredActivity(
          current,
          key,
          completedWork ? EVENT_KINDS.WORK_COMPLETED : EVENT_KINDS.ACTIVITY_IDLE,
          completedWork ? "completed" : "idle",
          "idle",
          occurredAt,
        );
        observation.state = "idle";
      }
      this.activity.set(key, observation);
      return;
    }

    const sample = processActivitySample(previous, current, elapsedMs);
    if (sample === "active") {
      observation.quietSince = null;
      if (observation.state !== "working") {
        this.emitInferredActivity(
          current,
          key,
          EVENT_KINDS.WORK_STARTED,
          "working",
          "working",
          occurredAt,
        );
        observation.state = "working";
      }
    } else if (sample === "quiet") {
      observation.quietSince ??= occurredAt;
      if (
        occurredAt - observation.quietSince >= this.activityIdleMs &&
        observation.state !== "idle"
      ) {
        this.emitInferredActivity(
          current,
          key,
          EVENT_KINDS.ACTIVITY_IDLE,
          "idle",
          "idle",
          occurredAt,
        );
        observation.state = "idle";
      }
    } else {
      observation.quietSince = null;
    }
    this.activity.set(key, observation);
  }

  start() {
    if (this.timer) return;
    this.tick();
    this.timer = setInterval(() => this.tick(), this.intervalMs);
    this.timer.unref?.();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  tick() {
    try {
      const occurredAt = this.now();
      const current = new Map(this.scan().map((item) => [item.processKey, item]));

      if (!this.initialized) {
        const currentSessionIds = new Set([...current.values()].map((item) => item.nativeSessionId));
        const currentProcesses = [...current.values()];
        for (const session of this.store.listLivePidSessions()) {
          const processOnly =
            session.telemetry === "process" && session.nativeSessionId.startsWith("process-");
          const stillRunning = processOnly
            ? currentSessionIds.has(session.nativeSessionId) ||
              currentProcesses.some((item) => sameProcessIncarnation(session, item))
            : currentProcesses.some((item) => sameProcessIncarnation(session, item));
          if (stillRunning) continue;
          this.markGone(session, `${session.harness}:${session.pid || session.nativeSessionId}:reconcile`);
        }
        this.initialized = true;
      }

      for (const [key, item] of current) {
        if (this.known.has(key)) continue;
        const matchingSessions = this.store
          .listLiveSessionsForPid(item.harness, item.pid)
          .filter((session) => sameProcessIncarnation(session, item));
        const nativeSessions = matchingSessions.filter(
          (session) => !session.nativeSessionId.startsWith("process-"),
        );
        const targets = nativeSessions.length ? nativeSessions : [matchingSessions[0] || item];
        for (const target of targets) {
          const preserveNativeLocation =
            Boolean(item.hostApplication) && target.telemetry !== "process";
          const nativeSessionId = target.nativeSessionId || item.nativeSessionId;
          this.store.ingest({
            eventId: this.eventId(key, `seen:${nativeSessionId}`),
            harness: item.harness,
            nativeSessionId,
            kind: EVENT_KINDS.PROCESS_SEEN,
            nativeType: "process.discovered",
            occurredAt,
            telemetry: "process",
            confidence: 0.45,
            metadata: {
              title: preserveNativeLocation ? null : item.title,
              cwd: preserveNativeLocation ? null : item.cwd,
              project: preserveNativeLocation ? null : item.project,
              pid: item.pid,
              terminal: item.terminal,
              terminalKind: item.terminalKind,
              terminalTarget: item.terminalTarget,
              terminalInstance: item.terminalInstance,
              hostApplication: item.hostApplication,
              hostPid: item.hostPid,
              startedAt: item.startedAt,
            },
          });
        }
        this.notifyProcessDiscovered(item, occurredAt);
      }

      for (const [key, item] of current) {
        const previous = this.known.get(key);
        this.emitCodexRolloutLifecycle(item);
        this.updateInferredActivity(key, previous, item, occurredAt);
      }

      for (const [key, item] of this.known) {
        if (current.has(key)) continue;
        this.markGone(item, key);
        this.activity.delete(key);
        this.codexApprovalEvidence.delete(key);
      }

      this.known = current;
      this.store.setAdapterHealth("process", { status: "ready", detail: `${current.size} harness processes found` });
    } catch (error) {
      this.store.setAdapterHealth("process", { status: "error", detail: error.message });
      this.logger.error?.(`[discovery] ${error.stack || error.message}`);
    }
  }
}
