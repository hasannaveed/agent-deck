import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { createSessionKey, EVENT_KINDS } from "../src/domain.js";
import {
  activityHintFromTerminalTitle,
  detectHarnessProcess,
  findHarnessAncestor,
  gnomeTerminalLocatorFrom,
  hasNestedHarnessMarker,
  isInteractiveHarnessProcess,
  isNestedHarnessProcess,
  LinuxProcessDiscovery,
  processActivitySample,
  readCodexRolloutLifecycle,
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

test("hook ancestry carries a VS Code application-host route", () => {
  const processes = new Map([
    [
      8184,
      {
        pid: 8184,
        parentPid: 7846,
        harness: "codex",
        comm: "codex",
        argv: [
          "/home/example/.vscode/extensions/openai.chatgpt-26.715.61943-linux-x64/bin/linux-x86_64/codex",
          "-c",
          "features.code_mode_host=true",
          "app-server",
        ],
        cwd: "/work/aim-project",
        startTicks: 100,
        environment: new Map(),
      },
    ],
    [
      7846,
      {
        pid: 7846,
        parentPid: 7440,
        harness: null,
        comm: "code",
        argv: [
          "/usr/share/code/code --type=utility --utility-sub-type=node.mojom.NodeService",
        ],
        environment: new Map(),
      },
    ],
    [
      7440,
      {
        pid: 7440,
        parentPid: 1,
        harness: null,
        comm: "code",
        argv: ["/usr/share/code/code"],
        environment: new Map(),
      },
    ],
  ]);

  const ancestor = findHarnessAncestor("codex", 8184, (pid) => processes.get(pid));
  assert.equal(ancestor.hostApplication, "vscode");
  assert.equal(ancestor.hostPid, 7846);
});

test("terminal discovery captures safe structured focus targets", () => {
  const tmux = terminalLocatorFrom({
    environment: new Map([
      ["TMUX", "/tmp/tmux-1000/default,123,0"],
      ["TMUX_PANE", "%12"],
      ["GNOME_TERMINAL_SCREEN", "/org/gnome/Terminal/screen/host_123"],
      ["GNOME_TERMINAL_SERVICE", ":1.55"],
    ]),
    tty: "/dev/pts/8",
  });
  assert.deepEqual(tmux, {
    label: "tmux %12",
    kind: "tmux",
    target: "%12",
    instance: "/tmp/tmux-1000/default",
  });
  assert.deepEqual(
    gnomeTerminalLocatorFrom({
      environment: new Map([
        ["GNOME_TERMINAL_SCREEN", "/org/gnome/Terminal/screen/host_123"],
        ["GNOME_TERMINAL_SERVICE", ":1.55"],
      ]),
      tty: "/dev/pts/8",
    }),
    {
      label: "GNOME Terminal · pts/8",
      kind: "gnome-terminal",
      target: "/org/gnome/Terminal/screen/host_123",
      instance: ":1.55",
    },
  );

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

test("Codex rollout discovery reads lifecycle metadata and excludes subagents", () => {
  const temporary = mkdtempSync(path.join(tmpdir(), "switchboard-codex-rollout-"));
  const sessionId = "11111111-2222-4333-8444-555555555555";
  const turnId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
  const main = path.join(temporary, `rollout-test-${sessionId}.jsonl`);
  const subagent = path.join(temporary, "rollout-test-99999999-2222-4333-8444-555555555555.jsonl");
  try {
    writeFileSync(
      main,
      [
        JSON.stringify({ type: "session_meta", payload: { id: sessionId, thread_source: "user" } }),
        JSON.stringify({ type: "response_item", payload: { type: "message", content: "PRIVATE" } }),
        JSON.stringify({
          timestamp: "2026-08-12T12:00:00.000Z",
          type: "event_msg",
          payload: { type: "turn_aborted", turn_id: turnId, reason: "interrupted" },
        }),
        "",
      ].join("\n"),
    );
    writeFileSync(
      subagent,
      `${JSON.stringify({ type: "session_meta", payload: { thread_source: "subagent" } })}\n`,
    );

    const parsed = readCodexRolloutLifecycle(main);
    assert.deepEqual(parsed, {
      sessionId,
      lifecycle: {
        type: "turn_aborted",
        turnId,
        occurredAt: Date.parse("2026-08-12T12:00:00.000Z"),
      },
    });
    assert.equal(JSON.stringify(parsed).includes("PRIVATE"), false);
    assert.equal(readCodexRolloutLifecycle(subagent), null);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

test("Codex rollout interruption overrides a stale Working process title", () => {
  const store = new SwitchboardStore(":memory:");
  try {
    let clock = Date.now();
    const sessionId = "11111111-2222-4333-8444-555555555555";
    const current = {
      processKey: "codex:32:320",
      harness: "codex",
      nativeSessionId: sessionId,
      pid: 32,
      title: "Current Codex",
      cwd: "/work/current",
      project: "current",
      terminal: "tmux %32",
      terminalKind: "tmux",
      terminalTarget: "%32",
      terminalInstance: "/tmp/tmux/default",
      activityHint: "working",
      startedAt: clock - 60_000,
      codexRollout: {
        sessionId,
        lifecycle: {
          type: "turn_aborted",
          turnId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
          occurredAt: clock - 1_000,
        },
      },
    };
    const provisional = store.ingest({
      eventId: "codex-rollout-provisional",
      harness: "codex",
      nativeSessionId: "process-32-320",
      kind: EVENT_KINDS.PROCESS_SEEN,
      nativeType: "process.discovered",
      occurredAt: clock - 2_000,
      telemetry: "process",
      metadata: {
        pid: current.pid,
        cwd: current.cwd,
        startedAt: current.startedAt,
        terminal: current.terminal,
        terminalKind: current.terminalKind,
        terminalTarget: current.terminalTarget,
        terminalInstance: current.terminalInstance,
      },
    });
    const discovery = new LinuxProcessDiscovery({
      store,
      scan: () => [current],
      now: () => clock,
      logger: { error() {} },
    });

    discovery.tick();
    let detail = store.getSessionDetail(createSessionKey("codex", sessionId));
    assert.equal(store.getSession(provisional.session.id), null);
    assert.equal(store.db.prepare("SELECT COUNT(*) AS count FROM sessions").get().count, 1);
    assert.equal(detail.session.primaryState, "interrupted");
    assert.equal(detail.session.unread, false);
    assert.equal(detail.session.telemetry, "native");

    clock += 2_500;
    discovery.tick();
    detail = store.getSessionDetail(createSessionKey("codex", sessionId));
    assert.equal(detail.session.primaryState, "interrupted");
    assert.equal(detail.events.filter((item) => item.kind === "work_interrupted").length, 1);
  } finally {
    store.close();
  }
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
  assert.equal(
    isInteractiveHarnessProcess({
      ...foreground,
      tty: "socket:[123]",
      argv: [
        "/home/example/.vscode/extensions/openai.chatgpt-26.715.61943-linux-x64/bin/linux-x86_64/codex",
        "-c",
        "features.code_mode_host=true",
        "app-server",
      ],
    }),
    true,
  );
});

test("nested harnesses are recognized through ancestry and inherited markers", () => {
  const parent = {
    pid: 100,
    parentPid: 1,
    harness: "opencode",
    environment: new Map(),
    terminalKind: null,
  };
  const shell = {
    pid: 101,
    parentPid: 100,
    harness: null,
    environment: new Map(),
  };
  const child = {
    pid: 102,
    parentPid: 101,
    harness: "opencode",
    environment: new Map(),
    terminalKind: null,
  };
  const processes = new Map([
    [100, parent],
    [101, shell],
  ]);

  assert.equal(isNestedHarnessProcess(parent, (pid) => processes.get(pid)), false);
  assert.equal(isNestedHarnessProcess(child, (pid) => processes.get(pid)), true);
  assert.equal(
    isNestedHarnessProcess({
      ...parent,
      environment: new Map([["AGENT_SWITCHBOARD_CHILD", "1"]]),
    }),
    true,
  );

  assert.equal(
    hasNestedHarnessMarker({
      ...parent,
      environment: new Map([["AGENT_SWITCHBOARD_CHILD", "1"]]),
      terminalKind: "tmux",
      terminalTarget: "%8",
    }),
    true,
  );
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

test("process discovery runs post-discovery actions only once per new process", () => {
  const store = new SwitchboardStore(":memory:");
  try {
    const clock = Date.now();
    const discovered = [];
    const current = {
      processKey: "codex:31:310",
      harness: "codex",
      nativeSessionId: "process-31-310",
      pid: 31,
      title: "Current Codex",
      cwd: "/work/current",
      project: "current",
      terminal: "GNOME Terminal · pts/7",
      terminalKind: "gnome-terminal",
      terminalTarget: "/org/gnome/Terminal/screen/abc_123",
      terminalInstance: ":1.42",
      startedAt: clock - 1_000,
    };
    const discovery = new LinuxProcessDiscovery({
      store,
      scan: () => [current],
      now: () => clock,
      onProcessDiscovered: (item, occurredAt) => discovered.push([item.processKey, occurredAt]),
      logger: { error() {} },
    });

    discovery.tick();
    discovery.tick();

    assert.deepEqual(discovered, [[current.processKey, clock]]);
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

test("VS Code discovery annotates every native thread without replacing its workspace", () => {
  const store = new SwitchboardStore(":memory:");
  try {
    const clock = Date.now();
    const startedAt = clock - 10_000;
    for (const [nativeSessionId, cwd] of [
      ["vscode-thread-one", "/work/project-one"],
      ["vscode-thread-two", "/work/project-two"],
    ]) {
      store.ingest({
        eventId: `start-${nativeSessionId}`,
        harness: "codex",
        nativeSessionId,
        kind: EVENT_KINDS.SESSION_STARTED,
        nativeType: "SessionStart",
        occurredAt: clock - 5_000,
        telemetry: "hook",
        metadata: { pid: 8184, cwd, startedAt },
      });
    }
    const current = {
      processKey: "codex:8184:100",
      harness: "codex",
      nativeSessionId: "process-8184-100",
      pid: 8184,
      title: "skylab · codex",
      cwd: "/home/example",
      project: "example",
      terminal: "socket:[123]",
      terminalKind: null,
      terminalTarget: null,
      terminalInstance: null,
      hostApplication: "vscode",
      hostPid: 7846,
      startedAt,
    };
    const discovery = new LinuxProcessDiscovery({
      store,
      scan: () => [current],
      now: () => clock,
      logger: { error() {} },
    });

    discovery.tick();
    const sessions = store.getSnapshot().sessions;
    assert.equal(sessions.length, 2);
    assert.deepEqual(
      sessions.map((session) => session.cwd).sort(),
      ["/work/project-one", "/work/project-two"],
    );
    assert.equal(sessions.every((session) => session.hostApplication === "vscode"), true);
    assert.equal(sessions.every((session) => session.hostPid === 7846), true);
    assert.equal(sessions.every((session) => session.focusProvider === "vscode"), true);
  } finally {
    store.close();
  }
});

test("a stable Codex tmux working title resolves an approved permission after two scans", () => {
  const store = new SwitchboardStore(":memory:");
  try {
    let clock = Date.now();
    let terminalTitle = "aim-project";
    const startedAt = clock - 1_000;
    const current = () => ({
      processKey: "codex:41:410",
      harness: "codex",
      nativeSessionId: "process-41-410",
      pid: 41,
      title: "Current Codex",
      cwd: "/work/current",
      project: "current",
      terminal: "tmux %41",
      terminalKind: "tmux",
      terminalTarget: "%41",
      terminalInstance: "/tmp/tmux/default",
      terminalTitle,
      activityHint: activityHintFromTerminalTitle("codex", terminalTitle),
      startedAt,
    });
    const discovery = new LinuxProcessDiscovery({
      store,
      intervalMs: 2_500,
      scan: () => [current()],
      now: () => clock,
      logger: { error() {} },
    });

    discovery.tick();
    const metadata = { pid: 41, startedAt };
    store.ingest({
      eventId: "codex-native-title-start",
      harness: "codex",
      nativeSessionId: "codex-native-title",
      kind: EVENT_KINDS.SESSION_STARTED,
      nativeType: "SessionStart",
      occurredAt: clock + 1,
      telemetry: "hook",
      metadata,
    });
    const attention = store.ingest({
      eventId: "codex-native-title-approval",
      harness: "codex",
      nativeSessionId: "codex-native-title",
      kind: EVENT_KINDS.ATTENTION_REQUESTED,
      nativeType: "PermissionRequest",
      occurredAt: clock + 2,
      telemetry: "hook",
      metadata,
      attention: { kind: "approval", summary: "Approval requested for Bash" },
    });

    terminalTitle = "[ . ] Action Required | aim-project";
    clock += 2_500;
    discovery.tick();
    clock += 2_500;
    discovery.tick();
    assert.equal(store.getSessionDetail(attention.session.id).session.primaryState, "needs_attention");

    terminalTitle = "⠹ aim-project";
    clock += 2_500;
    discovery.tick();
    assert.equal(store.getSessionDetail(attention.session.id).session.primaryState, "needs_attention");

    // Returning to Action Required invalidates the first working observation.
    terminalTitle = "[ . ] Action Required | aim-project";
    clock += 2_500;
    discovery.tick();
    terminalTitle = "⠴ aim-project";
    clock += 2_500;
    discovery.tick();
    assert.equal(store.getSessionDetail(attention.session.id).session.primaryState, "needs_attention");

    clock += 2_500;
    discovery.tick();
    const detail = store.getSessionDetail(attention.session.id);
    assert.equal(detail.session.primaryState, "working");
    assert.equal(detail.session.telemetry, "hook");
    assert.equal(detail.events[0].nativeType, "process.status.approval_resolved");
  } finally {
    store.close();
  }
});

test("Codex working-title evidence never clears a question", () => {
  const store = new SwitchboardStore(":memory:");
  try {
    let clock = Date.now();
    const startedAt = clock - 1_000;
    const current = {
      processKey: "codex:42:420",
      harness: "codex",
      nativeSessionId: "process-42-420",
      pid: 42,
      title: "Current Codex question",
      cwd: "/work/current",
      project: "current",
      terminal: "tmux %42",
      terminalKind: "tmux",
      terminalTarget: "%42",
      terminalInstance: "/tmp/tmux/default",
      terminalTitle: "⠹ current",
      activityHint: "working",
      startedAt,
    };
    const discovery = new LinuxProcessDiscovery({
      store,
      intervalMs: 2_500,
      scan: () => [current],
      now: () => clock,
      logger: { error() {} },
    });

    discovery.tick();
    const question = store.ingest({
      eventId: "codex-native-title-question",
      harness: "codex",
      nativeSessionId: "codex-native-question",
      kind: EVENT_KINDS.ATTENTION_REQUESTED,
      nativeType: "PreToolUse",
      occurredAt: clock + 1,
      telemetry: "hook",
      metadata: { pid: 42, startedAt },
      attention: { kind: "question", summary: "Codex has a question" },
    });

    clock += 2_500;
    discovery.tick();
    clock += 2_500;
    discovery.tick();
    assert.equal(store.getSessionDetail(question.session.id).session.primaryState, "needs_attention");
    assert.equal(
      store.getSessionDetail(question.session.id).events.some(
        (event) => event.nativeType === "process.status.approval_resolved",
      ),
      false,
    );

    const nonTmuxApproval = store.ingest({
      eventId: "codex-native-title-non-tmux-approval",
      harness: "codex",
      nativeSessionId: "codex-native-question",
      kind: EVENT_KINDS.ATTENTION_REQUESTED,
      nativeType: "PermissionRequest",
      occurredAt: clock + 1,
      telemetry: "hook",
      metadata: { pid: 42, startedAt },
      attention: { kind: "approval", summary: "Approval requested for Bash" },
    });
    current.terminalKind = "gnome-terminal";
    current.terminal = "GNOME Terminal · pts/42";
    current.terminalTarget = "/org/gnome/Terminal/screen/test_42";
    clock += 2_500;
    discovery.tick();
    clock += 2_500;
    discovery.tick();
    assert.equal(
      store.getSessionDetail(nonTmuxApproval.session.id).session.primaryState,
      "needs_attention",
    );
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
    const staleNative = store.ingest({
      eventId: "stale-native-attention",
      harness: "opencode",
      nativeSessionId: "native-stale-11",
      kind: EVENT_KINDS.ATTENTION_REQUESTED,
      nativeType: "permission.asked",
      telemetry: "native",
      metadata: { pid: 11, title: "Stale native OpenCode" },
      attention: {
        kind: "approval",
        requestId: "permission-stale",
        summary: "OpenCode is waiting for approval",
      },
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
    assert.equal(store.getSession(staleNative.session.id).presence, "closed");
    assert.equal(store.getSession(staleNative.session.id).attention, "none");
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

test("discovery reuses a native PID row after restart and removes a hidden provisional duplicate", () => {
  const store = new SwitchboardStore(":memory:");
  try {
    const terminal = {
      pid: 71,
      cwd: "/work/restart",
      title: "Restarted Codex",
      terminal: "tmux %4",
      terminalKind: "tmux",
      terminalTarget: "%4",
      terminalInstance: "/tmp/tmux/default",
    };
    const native = store.ingest({
      eventId: "native-before-restart",
      harness: "codex",
      nativeSessionId: "native-restart-71",
      kind: EVENT_KINDS.SESSION_STARTED,
      nativeType: "SessionStart",
      telemetry: "hook",
      metadata: terminal,
    });
    const current = {
      processKey: "codex:71:700",
      harness: "codex",
      nativeSessionId: "process-71-700",
      startedAt: Date.now() - 1_000,
      ...terminal,
    };
    // Simulate the hidden provisional row produced by an older daemon version.
    store.ingest({
      eventId: "legacy-hidden-process-row",
      harness: "codex",
      nativeSessionId: "process-71-700",
      kind: EVENT_KINDS.PROCESS_SEEN,
      nativeType: "process.discovered",
      telemetry: "process",
      metadata: terminal,
    });
    assert.equal(store.db.prepare("SELECT COUNT(*) AS count FROM sessions").get().count, 2);
    assert.equal(store.getSnapshot().sessions.length, 1);

    let scanned = [current];
    const discovery = new LinuxProcessDiscovery({
      store,
      scan: () => scanned,
      logger: { error() {} },
    });

    discovery.tick();
    assert.equal(store.db.prepare("SELECT COUNT(*) AS count FROM sessions").get().count, 1);
    assert.equal(store.getSnapshot().sessions[0].id, native.session.id);

    scanned = [];
    discovery.tick();
    assert.equal(store.listLiveSessionsForPid("codex", 71).length, 0);
    const recent = store.getSnapshot().sessions;
    assert.equal(recent.length, 1);
    assert.equal(recent[0].id, native.session.id);
    assert.equal(recent[0].presence, "closed");
  } finally {
    store.close();
  }
});

test("process discovery keeps a new process live when Linux reuses its PID", () => {
  const store = new SwitchboardStore(":memory:");
  let clock = 100_000;
  const oldProcess = {
    processKey: "codex:81:800",
    harness: "codex",
    nativeSessionId: "process-81-800",
    pid: 81,
    title: "Old Codex",
    cwd: "/work/reused-pid",
    project: "reused-pid",
    terminal: "tmux %8",
    terminalKind: "tmux",
    terminalTarget: "%8",
    terminalInstance: "/tmp/tmux/default",
    startedAt: 90_000,
  };
  const newProcess = {
    ...oldProcess,
    processKey: "codex:81:801",
    nativeSessionId: "process-81-801",
    title: "New Codex",
    startedAt: 190_000,
  };
  let scanned = [oldProcess];
  const discovery = new LinuxProcessDiscovery({
    store,
    scan: () => scanned,
    now: () => clock,
    logger: { error() {} },
  });

  try {
    discovery.tick();
    clock = 200_000;
    scanned = [newProcess];
    discovery.tick();

    assert.equal(store.getSession(createSessionKey("codex", oldProcess.nativeSessionId)).presence, "closed");
    assert.equal(store.getSession(createSessionKey("codex", newProcess.nativeSessionId)).presence, "live");
    assert.equal(store.resolveSessionForPid("codex", 81), createSessionKey("codex", newProcess.nativeSessionId));
  } finally {
    store.close();
  }
});

test("startup reconciliation does not merge a reused PID into a stale native session", () => {
  const store = new SwitchboardStore(":memory:");
  const stale = store.ingest({
    eventId: "native-old-pid",
    harness: "opencode",
    nativeSessionId: "native-old-pid",
    kind: EVENT_KINDS.SESSION_STARTED,
    nativeType: "session.created",
    occurredAt: 100_000,
    telemetry: "native",
    metadata: { pid: 91, startedAt: 90_000, cwd: "/work/reused-pid" },
  });
  const current = {
    processKey: "opencode:91:901",
    harness: "opencode",
    nativeSessionId: "process-91-901",
    pid: 91,
    title: "Current OpenCode",
    cwd: "/work/reused-pid",
    project: "reused-pid",
    terminal: "tmux %9",
    terminalKind: "tmux",
    terminalTarget: "%9",
    terminalInstance: "/tmp/tmux/default",
    startedAt: 190_000,
  };
  const discovery = new LinuxProcessDiscovery({
    store,
    scan: () => [current],
    now: () => 200_000,
    logger: { error() {} },
  });

  try {
    discovery.tick();
    assert.equal(store.getSession(stale.session.id).presence, "closed");
    assert.equal(store.getSession(createSessionKey("opencode", current.nativeSessionId)).presence, "live");
  } finally {
    store.close();
  }
});
