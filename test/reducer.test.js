import assert from "node:assert/strict";
import test from "node:test";
import { EVENT_KINDS, normalizeEvent } from "../src/domain.js";
import {
  decorateSession,
  derivePrimaryState,
  reduceSession,
  shouldIncludeSession,
  sortSessions,
} from "../src/reducer.js";

let sequence = 0;

function event(kind, overrides = {}) {
  sequence += 1;
  return normalizeEvent({
    eventId: `reducer-${sequence}`,
    harness: "codex",
    nativeSessionId: "session-a",
    kind,
    nativeType: `test.${kind}`,
    occurredAt: Date.now() - 1000 + sequence,
    metadata: { cwd: "/work/switchboard", title: "Switchboard" },
    ...overrides,
  });
}

test("the reducer follows the working, attention, unread, and seen lifecycle", () => {
  let session = reduceSession(null, event(EVENT_KINDS.SESSION_STARTED));
  assert.equal(decorateSession(session).primaryState, "idle");

  session = reduceSession(session, event(EVENT_KINDS.WORK_STARTED, { humanInitiated: true }));
  assert.equal(decorateSession(session).primaryState, "working");

  session = reduceSession(
    session,
    event(EVENT_KINDS.ATTENTION_REQUESTED, {
      attention: { kind: "approval", requestId: "request-1", summary: "Approve Bash" },
    }),
  );
  assert.equal(decorateSession(session).primaryState, "needs_attention");
  assert.equal(session.attentionSummary, "Approve Bash");

  session = reduceSession(session, event(EVENT_KINDS.ATTENTION_RESOLVED));
  assert.equal(decorateSession(session).primaryState, "working");

  session = reduceSession(
    session,
    event(EVENT_KINDS.WORK_COMPLETED, {
      completion: { outcome: "completed", summary: "Done" },
    }),
  );
  assert.equal(decorateSession(session).primaryState, "unread");
  assert.equal(session.completionSeq, 1);

  session = reduceSession(session, event(EVENT_KINDS.WORK_STARTED, { humanInitiated: true }));
  assert.equal(session.unread, false);
  assert.equal(session.seenSeq, 1);
  assert.equal(decorateSession(session).primaryState, "working");
});

test("native busy updates do not clear an explicit human-input request", () => {
  let session = reduceSession(null, event(EVENT_KINDS.SESSION_STARTED));
  session = reduceSession(
    session,
    event(EVENT_KINDS.ATTENTION_REQUESTED, {
      telemetry: "native",
      attention: { kind: "approval", requestId: "request-race", summary: "Approve command" },
    }),
  );

  session = reduceSession(session, event(EVENT_KINDS.WORK_STARTED, { telemetry: "native" }));
  assert.equal(decorateSession(session).primaryState, "needs_attention");

  session = reduceSession(session, event(EVENT_KINDS.ATTENTION_RESOLVED, { telemetry: "native" }));
  assert.equal(decorateSession(session).primaryState, "working");
});

test("an interrupted turn stops working without creating an unread result", () => {
  let session = reduceSession(null, event(EVENT_KINDS.SESSION_STARTED));
  session = reduceSession(session, event(EVENT_KINDS.WORK_STARTED, { humanInitiated: true }));
  session = reduceSession(
    session,
    event(EVENT_KINDS.WORK_INTERRUPTED, { nativeType: "codex.rollout.turn_aborted" }),
  );

  assert.equal(session.activity, "interrupted");
  assert.equal(session.unread, false);
  assert.equal(session.completionSeq, 0);
  assert.equal(decorateSession(session).primaryState, "interrupted");
  assert.equal(decorateSession(session).group, "open");

  session = reduceSession(session, event(EVENT_KINDS.ACTIVITY_IDLE));
  assert.equal(decorateSession(session).primaryState, "interrupted");

  session = reduceSession(
    session,
    event(EVENT_KINDS.WORK_COMPLETED, {
      completion: { outcome: "completed", summary: "Cleanup idle" },
    }),
  );
  assert.equal(decorateSession(session).primaryState, "interrupted");
  assert.equal(session.completionSeq, 0);

  session = reduceSession(session, event(EVENT_KINDS.WORK_STARTED, { humanInitiated: true }));
  assert.equal(decorateSession(session).primaryState, "working");
});

test("errors outrank attention, unread, and working", () => {
  const base = reduceSession(null, event(EVENT_KINDS.SESSION_STARTED));
  const sessions = [
    { ...base, id: "idle", nativeSessionId: "idle", activity: "idle" },
    { ...base, id: "working", nativeSessionId: "working", activity: "working" },
    { ...base, id: "interrupted", nativeSessionId: "interrupted", activity: "interrupted" },
    { ...base, id: "unread", nativeSessionId: "unread", unread: true },
    { ...base, id: "attention", nativeSessionId: "attention", attention: "required" },
    { ...base, id: "error", nativeSessionId: "error", errorKind: "connection" },
  ];

  assert.deepEqual(
    sortSessions(sessions).map((session) => session.id),
    ["error", "attention", "unread", "working", "interrupted", "idle"],
  );
});

test("closed sessions become recent and expire even with unresolved signals", () => {
  const now = Date.now();
  const old = {
    ...reduceSession(null, event(EVENT_KINDS.SESSION_STARTED)),
    presence: "closed",
    updatedAt: now - 48 * 60 * 60 * 1000,
  };
  assert.equal(shouldIncludeSession(old, now, 24), false);
  assert.equal(shouldIncludeSession({ ...old, unread: true }, now, 24), false);
  assert.equal(shouldIncludeSession({ ...old, errorKind: "failed" }, now, 24), false);
  assert.equal(shouldIncludeSession({ ...old, unread: true, dismissed: true }, now, 24), false);
  assert.equal(derivePrimaryState({ ...old, unread: true, errorKind: "failed" }), "recent");
});

test("only live sessions with a supported terminal target are focusable", () => {
  const session = reduceSession(
    null,
    event(EVENT_KINDS.SESSION_STARTED, {
      metadata: {
        cwd: "/work/switchboard",
        terminal: "wezterm pane 42",
        terminalKind: "wezterm",
        terminalTarget: "42",
      },
    }),
  );

  assert.equal(decorateSession(session).focusable, true);
  assert.equal(decorateSession(session).focusProvider, "wezterm");
  assert.equal(decorateSession({ ...session, presence: "closed" }).focusable, false);
  assert.equal(
    decorateSession({
      ...session,
      terminalKind: "gnome-terminal",
      terminalTarget: "/org/gnome/Terminal/screen/abc_123",
      terminalInstance: ":1.142",
    }).focusable,
    true,
  );
});

test("event normalization keeps invalid confidence and numeric timestamps safe", () => {
  const occurredAt = Date.now() - 5_000;
  const malformed = normalizeEvent({
    harness: "codex",
    nativeSessionId: "normalization-safety",
    kind: EVENT_KINDS.SESSION_STARTED,
    confidence: "not-a-number",
    occurredAt: String(occurredAt),
  });
  assert.equal(malformed.confidence, 1);
  assert.equal(malformed.occurredAt, occurredAt);

  const process = normalizeEvent({
    harness: "codex",
    nativeSessionId: "normalization-process",
    kind: EVENT_KINDS.PROCESS_SEEN,
    telemetry: "process",
    confidence: Number.NaN,
  });
  assert.equal(process.confidence, 0.45);
  assert.equal(normalizeEvent({ ...process, eventId: "clamped-high", confidence: 4 }).confidence, 1);
  assert.equal(normalizeEvent({ ...process, eventId: "clamped-low", confidence: -2 }).confidence, 0);
});
