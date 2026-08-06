import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { EVENT_KINDS } from "../src/domain.js";
import { SwitchboardStore } from "../src/store.js";

function input(eventId, kind, overrides = {}) {
  return {
    eventId,
    harness: "codex",
    nativeSessionId: "store-session",
    kind,
    nativeType: `test.${kind}`,
    occurredAt: Date.now(),
    metadata: { cwd: "/work/store", title: "Store session" },
    ...overrides,
  };
}

test("the SQLite store deduplicates events and persists read state", () => {
  const store = new SwitchboardStore(":memory:");
  try {
    assert.equal(store.ingest(input("start", EVENT_KINDS.SESSION_STARTED)).accepted, true);
    assert.equal(store.ingest(input("work", EVENT_KINDS.WORK_STARTED)).accepted, true);
    assert.equal(
      store.ingest(
        input("done", EVENT_KINDS.WORK_COMPLETED, {
          completion: { outcome: "completed", summary: "Finished" },
        }),
      ).session.primaryState,
      "unread",
    );

    const duplicate = store.ingest(input("done", EVENT_KINDS.WORK_COMPLETED));
    assert.equal(duplicate.accepted, false);
    assert.equal(duplicate.duplicate, true);
    assert.equal(store.getSnapshot().counts.unread, 1);
    assert.equal(store.getSnapshot().counts.needsYou, 0);

    const id = store.getSnapshot().sessions[0].id;
    assert.equal(store.markSeen(id).primaryState, "idle");
    assert.equal(store.getSessionDetail(id).events.length, 3);
    assert.equal(store.markUnread(id).primaryState, "unread");
  } finally {
    store.close();
  }
});

test("a native event merges a process-discovered provisional session by PID", () => {
  const store = new SwitchboardStore(":memory:");
  try {
    store.ingest({
      eventId: "process-seen",
      harness: "claude",
      nativeSessionId: "process-4242-12",
      kind: EVENT_KINDS.PROCESS_SEEN,
      nativeType: "process.discovered",
      telemetry: "process",
      metadata: { pid: 4242, cwd: "/work/merge" },
    });
    const native = store.ingest({
      eventId: "native-start",
      harness: "claude",
      nativeSessionId: "native-session",
      kind: EVENT_KINDS.SESSION_STARTED,
      nativeType: "SessionStart",
      telemetry: "hook",
      metadata: { pid: 4242, cwd: "/work/merge", title: "Merged" },
    });

    const snapshot = store.getSnapshot();
    assert.equal(snapshot.sessions.length, 1);
    assert.equal(native.session.nativeSessionId, "native-session");
    assert.equal(native.session.telemetry, "hook");
    assert.equal(store.getSessionDetail(native.session.id).events.length, 2);
  } finally {
    store.close();
  }
});

test("closed ordinary sessions obey the recent window and dismissal", () => {
  const store = new SwitchboardStore(":memory:");
  try {
    const occurredAt = Date.now() - 48 * 60 * 60 * 1000;
    const started = store.ingest(input("old-start", EVENT_KINDS.SESSION_STARTED, { occurredAt }));
    store.ingest(input("old-end", EVENT_KINDS.SESSION_ENDED, { occurredAt: occurredAt + 1 }));
    assert.equal(store.listSessions({ recentHours: 24 }).length, 0);

    store.markUnread(started.session.id);
    assert.equal(store.listSessions({ recentHours: 24 }).length, 1);
    store.dismiss(started.session.id);
    assert.equal(store.listSessions({ recentHours: 24 }).length, 0);
  } finally {
    store.close();
  }
});

test("superseded process rows in the same terminal and workspace collapse to one session", () => {
  const store = new SwitchboardStore(":memory:");
  try {
    const terminal = {
      cwd: "/work/switchboard",
      terminal: "tmux %7",
      terminalKind: "tmux",
      terminalTarget: "%7",
    };
    const old = store.ingest({
      eventId: "old-process-seen",
      harness: "codex",
      nativeSessionId: "process-100-1000",
      kind: EVENT_KINDS.PROCESS_SEEN,
      nativeType: "process.discovered",
      telemetry: "process",
      occurredAt: Date.now() - 1000,
      metadata: { ...terminal, pid: 100 },
    });
    store.ingest({
      eventId: "old-process-gone",
      harness: "codex",
      nativeSessionId: "process-100-1000",
      kind: EVENT_KINDS.PROCESS_GONE,
      nativeType: "process.exited",
      telemetry: "process",
      occurredAt: Date.now() - 900,
      metadata: { pid: 100 },
    });
    const current = store.ingest({
      eventId: "current-process-seen",
      harness: "codex",
      nativeSessionId: "process-200-2000",
      kind: EVENT_KINDS.PROCESS_SEEN,
      nativeType: "process.discovered",
      telemetry: "process",
      metadata: { ...terminal, pid: 200 },
    });

    assert.deepEqual(store.getSnapshot().sessions.map((session) => session.id), [current.session.id]);
    assert.equal(store.getSession(old.session.id).presence, "closed");

    store.ingest({
      eventId: "other-pane-seen",
      harness: "codex",
      nativeSessionId: "process-300-3000",
      kind: EVENT_KINDS.PROCESS_SEEN,
      nativeType: "process.discovered",
      telemetry: "process",
      metadata: {
        ...terminal,
        pid: 300,
        terminal: "tmux %8",
        terminalTarget: "%8",
      },
    });
    assert.equal(store.getSnapshot().sessions.length, 2);
  } finally {
    store.close();
  }
});

test("demo cleanup removes only sessions created by demo events", () => {
  const store = new SwitchboardStore(":memory:");
  try {
    store.ingest(input("real-start", EVENT_KINDS.SESSION_STARTED));
    store.ingest(
      input("demo-start", EVENT_KINDS.SESSION_STARTED, {
        nativeSessionId: "demo-codex-working",
        nativeType: "demo.session_started",
        metadata: { cwd: "/workspace/demo", title: "Fake session" },
      }),
    );
    store.setAdapterHealth("codex", { status: "ready", detail: "Last event: demo.session_started" });

    assert.deepEqual(store.clearDemoData(), { sessions: 1, events: 1, adapters: 1 });
    assert.equal(store.getSnapshot().sessions.length, 1);
    assert.equal(store.getSnapshot().sessions[0].nativeSessionId, "store-session");
    assert.equal(store.getSessionDetail(store.getSnapshot().sessions[0].id).events.length, 1);
  } finally {
    store.close();
  }
});

test("terminal focus coordinates survive storage and decorate the session", () => {
  const store = new SwitchboardStore(":memory:");
  try {
    const result = store.ingest(
      input("focus-start", EVENT_KINDS.SESSION_STARTED, {
        metadata: {
          cwd: "/work/store",
          title: "Focus session",
          terminal: "tmux %8",
          terminalKind: "tmux",
          terminalTarget: "%8",
          terminalInstance: "/tmp/tmux-1000/default",
        },
      }),
    );

    assert.equal(result.session.focusable, true);
    assert.equal(result.session.focusProvider, "tmux");
    assert.equal(store.getSnapshot().sessions[0].terminalTarget, "%8");
    assert.equal(store.getSessionDetail(result.session.id).session.terminalInstance, "/tmp/tmux-1000/default");
  } finally {
    store.close();
  }
});

test("an existing schema is upgraded with terminal focus columns", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "switchboard-migration-"));
  const databasePath = path.join(directory, "switchboard.sqlite");
  try {
    const original = new SwitchboardStore(databasePath);
    original.close();

    const legacy = new DatabaseSync(databasePath);
    legacy.exec(`
      ALTER TABLE sessions DROP COLUMN terminalInstance;
      ALTER TABLE sessions DROP COLUMN terminalTarget;
      ALTER TABLE sessions DROP COLUMN terminalKind;
      UPDATE meta SET value = '1' WHERE key = 'schemaVersion';
    `);
    legacy.close();

    const upgraded = new SwitchboardStore(databasePath);
    try {
      const columns = upgraded.db.prepare("PRAGMA table_info(sessions)").all().map((column) => column.name);
      assert.equal(columns.includes("terminalKind"), true);
      assert.equal(columns.includes("terminalTarget"), true);
      assert.equal(columns.includes("terminalInstance"), true);
      assert.equal(upgraded.db.prepare("SELECT value FROM meta WHERE key = 'schemaVersion'").get().value, "2");
    } finally {
      upgraded.close();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
