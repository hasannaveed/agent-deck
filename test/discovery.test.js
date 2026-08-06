import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { EVENT_KINDS } from "../src/domain.js";
import {
  activityHintFromTerminalTitle,
  detectHarnessProcess,
  isInteractiveHarnessProcess,
  LinuxProcessDiscovery,
  processActivitySample,
  readOpenCodeActivityHint,
  readTerminalTitle,
  terminalLocatorFrom,
} from "../src/discovery/linux.js";
import { SwitchboardStore } from "../src/store.js";

test("process discovery uses exact harness executable signatures", () => {
  assert.equal(detectHarnessProcess({ comm: "codex", argv: ["/usr/bin/codex"] }), "codex");
  assert.equal(
    detectHarnessProcess({ comm: "node", argv: ["node", "/opt/node_modules/@anthropic-ai/claude-code/cli.js"] }),
    "claude",
  );
  assert.equal(detectHarnessProcess({ comm: "opencode", argv: ["/usr/bin/opencode"] }), "opencode");
  assert.equal(detectHarnessProcess({ comm: "node", argv: ["node", "/work/codex-notes.js"] }), null);
});

test("terminal discovery captures safe structured focus targets", () => {
  const tmux = terminalLocatorFrom({
    environment: new Map([
      ["TMUX", "/tmp/tmux-1000/default,123,0"],
      ["TMUX_PANE", "%12"],
    ]),
    tty: "/dev/pts/8",
  });
  assert.deepEqual(tmux, {
    label: "tmux %12",
    kind: "tmux",
    target: "%12",
    instance: "/tmp/tmux-1000/default",
  });

  const wezterm = terminalLocatorFrom({
    environment: new Map([
      ["WEZTERM_PANE", "44"],
      ["WEZTERM_UNIX_SOCKET", "/run/user/1000/wezterm/gui-sock-1"],
    ]),
    tty: "/dev/pts/9",
  });
  assert.equal(wezterm.kind, "wezterm");
  assert.equal(wezterm.target, "44");
  assert.equal(wezterm.instance, "/run/user/1000/wezterm/gui-sock-1");

  const kitty = terminalLocatorFrom({
    environment: new Map([
      ["KITTY_WINDOW_ID", "9"],
      ["KITTY_LISTEN_ON", "unix:/tmp/kitty-control"],
    ]),
    tty: "/dev/pts/10",
  });
  assert.equal(kitty.target, "9");
  assert.equal(kitty.instance, "unix:/tmp/kitty-control");

  const gnome = terminalLocatorFrom({
    environment: new Map([
      ["GNOME_TERMINAL_SCREEN", "/org/gnome/Terminal/screen/abc_123"],
      ["GNOME_TERMINAL_SERVICE", ":1.142"],
    ]),
    tty: "/dev/pts/11",
  });
  assert.deepEqual(gnome, {
    label: "GNOME Terminal · pts/11",
    kind: "gnome-terminal",
    target: "/org/gnome/Terminal/screen/abc_123",
    instance: ":1.142",
  });
});

test("tmux pane titles provide Codex status hints without reading pane content", () => {
  const calls = [];
  const processInfo = {
    terminalKind: "tmux",
    terminalTarget: "%12",
    terminalInstance: "/tmp/tmux-1000/default",
  };
  const title = readTerminalTitle(processInfo, (command, args, options) => {
    calls.push({ command, args, options });
    return "⠹ switchboard\n";
  });

  assert.equal(title, "⠹ switchboard");
  assert.equal(calls[0].command, "tmux");
  assert.deepEqual(calls[0].args, [
    "-S",
    "/tmp/tmux-1000/default",
    "display-message",
    "-p",
    "-t",
    "%12",
    "#{pane_title}",
  ]);
  assert.equal(activityHintFromTerminalTitle("codex", title), "working");
  assert.equal(activityHintFromTerminalTitle("codex", "[ . ] Action Required | switchboard"), "needs_attention");
  assert.equal(activityHintFromTerminalTitle("codex", "switchboard"), "idle");
  assert.equal(activityHintFromTerminalTitle("opencode", "switchboard"), null);
  assert.equal(readTerminalTitle({ ...processInfo, terminalTarget: "not-a-pane" }, () => assert.fail()), null);
});

test("OpenCode lifecycle metadata treats queued tools as working, not human attention", () => {
  const database = new DatabaseSync(":memory:");
  try {
    database.exec(`
      CREATE TABLE session (
        id TEXT PRIMARY KEY,
        directory TEXT NOT NULL,
        title TEXT NOT NULL,
        time_updated INTEGER NOT NULL,
        time_archived INTEGER
      );
      CREATE TABLE message (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        time_created INTEGER NOT NULL,
        data TEXT NOT NULL
      );
      CREATE TABLE part (
        id TEXT PRIMARY KEY,
        message_id TEXT NOT NULL,
        time_updated INTEGER NOT NULL,
        data TEXT NOT NULL
      );
    `);
    database
      .prepare("INSERT INTO session(id, directory, title, time_updated) VALUES (?, ?, ?, ?)")
      .run("session-1", "/work/current", "Current task", 100);
    database
      .prepare("INSERT INTO message(id, session_id, time_created, data) VALUES (?, ?, ?, ?)")
      .run("message-1", "session-1", 100, JSON.stringify({ role: "assistant", time: {} }));
    const processInfo = {
      harness: "opencode",
      cwd: "/work/current",
      terminalTitle: "OC | Current task",
    };

    assert.equal(readOpenCodeActivityHint(processInfo, { database }), "working");

    database
      .prepare("INSERT INTO part(id, message_id, time_updated, data) VALUES (?, ?, ?, ?)")
      .run("part-1", "message-1", 101, JSON.stringify({ type: "tool", state: { status: "pending" } }));
    assert.equal(readOpenCodeActivityHint(processInfo, { database }), "working");

    database
      .prepare("UPDATE part SET data = ? WHERE id = ?")
      .run(JSON.stringify({ type: "tool", state: { status: "running" } }), "part-1");
    assert.equal(readOpenCodeActivityHint(processInfo, { database }), "working");

    database
      .prepare("UPDATE part SET data = ? WHERE id = ?")
      .run(JSON.stringify({ type: "tool", state: { status: "completed" } }), "part-1");
    database
      .prepare("UPDATE message SET data = ? WHERE id = ?")
      .run(JSON.stringify({ role: "assistant", time: { completed: 102 } }), "message-1");
    assert.equal(readOpenCodeActivityHint(processInfo, { database }), "idle");
  } finally {
    database.close();
  }
});

test("fallback discovery keeps only foreground terminal harnesses", () => {
  const foreground = {
    harness: "codex",
    state: "S",
    tty: "/dev/pts/3",
    processGroup: 120,
    foregroundProcessGroup: 120,
  };
  assert.equal(isInteractiveHarnessProcess(foreground), true);
  assert.equal(isInteractiveHarnessProcess({ ...foreground, state: "T" }), false);
  assert.equal(isInteractiveHarnessProcess({ ...foreground, processGroup: 119 }), false);
  assert.equal(isInteractiveHarnessProcess({ ...foreground, tty: "socket:[123]" }), false);
});

test("process activity samples distinguish active, quiet, and unavailable counters", () => {
  const previous = { cpuTicks: 100, ioChars: 10_000 };
  assert.equal(processActivitySample(previous, { cpuTicks: 125, ioChars: 11_000 }, 2500), "active");
  assert.equal(processActivitySample(previous, { cpuTicks: 111, ioChars: 11_000 }, 2500), "quiet");
  assert.equal(processActivitySample({}, {}, 2500), null);
});

test("counter-only process discovery idles without fabricating an unread result", () => {
  const store = new SwitchboardStore(":memory:");
  try {
    let clock = Date.now();
    let counters = { cpuTicks: 100, ioChars: 10_000 };
    const current = () => ({
      processKey: "codex:30:300",
      harness: "codex",
      nativeSessionId: "process-30-300",
      pid: 30,
      title: "Current Codex",
      cwd: "/work/current",
      project: "current",
      terminal: "tmux %3",
      terminalKind: "tmux",
      terminalTarget: "%3",
      terminalInstance: "/tmp/tmux/default",
      startedAt: clock - 1000,
      ...counters,
    });
    const discovery = new LinuxProcessDiscovery({
      store,
      intervalMs: 2500,
      activityIdleMs: 5000,
      scan: () => [current()],
      now: () => clock,
      logger: { error() {} },
    });

    discovery.tick();
    const id = store.resolveSessionForPid("codex", 30);
    assert.equal(store.getSessionDetail(id).session.primaryState, "unknown");

    clock += 2500;
    counters = { cpuTicks: 125, ioChars: 11_000 };
    discovery.tick();
    assert.equal(store.getSessionDetail(id).session.primaryState, "working");

    clock += 2500;
    discovery.tick();
    assert.equal(store.getSessionDetail(id).session.primaryState, "working");

    clock += 5000;
    discovery.tick();
    assert.equal(store.getSessionDetail(id).session.primaryState, "idle");
    assert.equal(store.getSessionDetail(id).session.unread, false);
    assert.equal(store.getSessionDetail(id).events.length, 3);
  } finally {
    store.close();
  }
});

test("reliable terminal hints turn completed work into unread until it is seen", () => {
  const store = new SwitchboardStore(":memory:");
  try {
    let clock = Date.now();
    let activityHint = "needs_attention";
    let counters = { cpuTicks: 100, ioChars: 10_000 };
    const current = () => ({
      processKey: "codex:35:350",
      harness: "codex",
      nativeSessionId: "process-35-350",
      pid: 35,
      title: "Current Codex",
      cwd: "/work/current",
      terminal: "tmux %35",
      terminalKind: "tmux",
      terminalTarget: "%35",
      terminalInstance: "/tmp/tmux/default",
      activityHint,
      ...counters,
    });
    const discovery = new LinuxProcessDiscovery({
      store,
      intervalMs: 2500,
      scan: () => [current()],
      now: () => clock,
      logger: { error() {} },
    });

    discovery.tick();
    const id = store.resolveSessionForPid("codex", 35);
    assert.equal(store.getSessionDetail(id).session.primaryState, "needs_attention");

    clock += 2500;
    counters = { cpuTicks: 500, ioChars: 10_000_000 };
    discovery.tick();
    assert.equal(store.getSessionDetail(id).session.primaryState, "needs_attention");

    activityHint = "working";
    clock += 2500;
    discovery.tick();
    assert.equal(store.getSessionDetail(id).session.primaryState, "working");

    activityHint = "idle";
    clock += 2500;
    discovery.tick();
    let detail = store.getSessionDetail(id);
    assert.equal(detail.session.primaryState, "unread");
    assert.equal(detail.session.unread, true);
    assert.equal(detail.events[0].nativeType, "process.activity.completed");

    assert.equal(store.markSeen(id).primaryState, "idle");
    clock += 2500;
    discovery.tick();
    detail = store.getSessionDetail(id);
    assert.equal(detail.session.primaryState, "idle");
    assert.equal(detail.session.unread, false);
  } finally {
    store.close();
  }
});

test("process inference does not override native harness activity", () => {
  const store = new SwitchboardStore(":memory:");
  try {
    let clock = Date.now();
    const current = {
      processKey: "claude:40:400",
      harness: "claude",
      nativeSessionId: "process-40-400",
      pid: 40,
      title: "Current Claude",
      cpuTicks: 100,
      ioChars: 10_000,
    };
    const discovery = new LinuxProcessDiscovery({
      store,
      intervalMs: 2500,
      activityIdleMs: 5000,
      scan: () => [current],
      now: () => clock,
      logger: { error() {} },
    });

    discovery.tick();
    store.ingest({
      eventId: "native-start",
      harness: "claude",
      nativeSessionId: "claude-native-40",
      kind: EVENT_KINDS.SESSION_STARTED,
      nativeType: "SessionStart",
      occurredAt: clock + 1,
      telemetry: "hook",
      metadata: { pid: 40 },
    });
    const native = store.ingest({
      eventId: "native-work",
      harness: "claude",
      nativeSessionId: "claude-native-40",
      kind: EVENT_KINDS.WORK_STARTED,
      nativeType: "UserPromptSubmit",
      occurredAt: clock + 2,
      telemetry: "hook",
      metadata: { pid: 40 },
    });

    clock += 10_000;
    discovery.tick();
    clock += 10_000;
    discovery.tick();
    const detail = store.getSessionDetail(native.session.id);
    assert.equal(detail.session.primaryState, "working");
    assert.equal(detail.events.some((event) => event.nativeType === "process.activity.idle"), false);
  } finally {
    store.close();
  }
});

test("process discovery reconciles stale rows and can reopen a resumed process", () => {
  const store = new SwitchboardStore(":memory:");
  try {
    store.ingest({
      eventId: "stale-seen",
      harness: "codex",
      nativeSessionId: "process-10-100",
      kind: EVENT_KINDS.PROCESS_SEEN,
      nativeType: "process.discovered",
      telemetry: "process",
      metadata: { pid: 10, title: "Stale Codex" },
    });

    const current = {
      processKey: "opencode:20:200",
      harness: "opencode",
      nativeSessionId: "process-20-200",
      pid: 20,
      title: "Current OpenCode",
      cwd: "/work/current",
      project: "current",
      terminal: "tmux %2",
      terminalKind: "tmux",
      terminalTarget: "%2",
      terminalInstance: "/tmp/tmux/default",
      startedAt: Date.now() - 1000,
    };
    let scanned = [current];
    const discovery = new LinuxProcessDiscovery({ store, scan: () => scanned, logger: { error() {} } });

    discovery.tick();
    assert.equal(store.getSession(store.resolveSessionForPid("codex", 10)).presence, "closed");
    const currentId = store.resolveSessionForPid("opencode", 20);
    assert.equal(store.getSession(currentId).presence, "live");

    scanned = [];
    discovery.tick();
    assert.equal(store.getSession(currentId).presence, "closed");

    scanned = [current];
    discovery.tick();
    assert.equal(store.getSession(currentId).presence, "live");
    assert.equal(store.getSessionDetail(currentId).events.length, 3);
  } finally {
    store.close();
  }
});
