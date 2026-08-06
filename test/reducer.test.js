import assert from "node:assert/strict";
import test from "node:test";
import { EVENT_KINDS, normalizeEvent } from "../src/domain.js";
import {
  decorateSession,
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

test("errors outrank attention, unread, and working", () => {
  const base = reduceSession(null, event(EVENT_KINDS.SESSION_STARTED));
  const sessions = [
    { ...base, id: "idle", nativeSessionId: "idle", activity: "idle" },
    { ...base, id: "working", nativeSessionId: "working", activity: "working" },
    { ...base, id: "unread", nativeSessionId: "unread", unread: true },
    { ...base, id: "attention", nativeSessionId: "attention", attention: "required" },
    { ...base, id: "error", nativeSessionId: "error", errorKind: "connection" },
  ];

  assert.deepEqual(
    sortSessions(sessions).map((session) => session.id),
    ["error", "attention", "unread", "working", "idle"],
  );
});

test("closed sessions expire, while unresolved signals stay until dismissed", () => {
  const now = Date.now();
  const old = {
    ...reduceSession(null, event(EVENT_KINDS.SESSION_STARTED)),
    presence: "closed",
    updatedAt: now - 48 * 60 * 60 * 1000,
  };
  assert.equal(shouldIncludeSession(old, now, 24), false);
  assert.equal(shouldIncludeSession({ ...old, unread: true }, now, 24), true);
  assert.equal(shouldIncludeSession({ ...old, errorKind: "failed" }, now, 24), true);
  assert.equal(shouldIncludeSession({ ...old, unread: true, dismissed: true }, now, 24), false);
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
  assert.equal(decorateSession({ ...session, terminalKind: "gnome-terminal" }).focusable, false);
});
