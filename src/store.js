import { EventEmitter } from "node:events";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { normalizeEvent } from "./domain.js";
import {
  decorateSession,
  reduceSession,
  shouldIncludeSession,
  sortSessions,
} from "./reducer.js";

const SESSION_COLUMNS = [
  "id",
  "harness",
  "nativeSessionId",
  "title",
  "cwd",
  "project",
  "branch",
  "presence",
  "activity",
  "attention",
  "attentionKind",
  "attentionRequestId",
  "attentionSummary",
  "unread",
  "errorKind",
  "errorSummary",
  "telemetry",
  "confidence",
  "pid",
  "terminal",
  "terminalKind",
  "terminalTarget",
  "terminalInstance",
  "startedAt",
  "lastActivityAt",
  "completedAt",
  "seenAt",
  "endedAt",
  "completionSeq",
  "seenSeq",
  "dismissed",
  "lastEventType",
  "lastEventAt",
  "createdAt",
  "updatedAt",
];

function toDatabaseSession(session) {
  return {
    ...session,
    unread: session.unread ? 1 : 0,
    dismissed: session.dismissed ? 1 : 0,
  };
}

function fromDatabaseSession(row) {
  if (!row) return null;
  return {
    ...row,
    unread: Boolean(row.unread),
    dismissed: Boolean(row.dismissed),
  };
}

function eventSummary(event) {
  if (event.kind === "attention_requested") return event.attention.summary;
  if (event.kind === "session_error") return event.error.summary;
  if (event.kind === "work_completed") return event.completion.summary;
  return null;
}

function sessionTerminalIdentity(session) {
  if (!session.harness || !session.cwd) return null;
  let locator = null;
  if (session.terminalKind && session.terminalTarget) {
    locator = `${session.terminalKind}:${session.terminalTarget}`;
  } else if (session.terminal) {
    const terminal = session.terminal.trim().toLowerCase();
    const known = terminal.match(/^(tmux)\s+(%\d+)$|^(wezterm pane|kitty window)\s+(\d+)$/);
    locator = known
      ? known[1]
        ? `${known[1]}:${known[2]}`
        : `${known[3].replace(" pane", "").replace(" window", "")}:${known[4]}`
      : `label:${terminal}`;
  }
  return locator ? `${session.harness}\0${session.cwd}\0${locator}` : null;
}

function isProcessDiscoveredSession(session) {
  return session.telemetry === "process" && session.nativeSessionId.startsWith("process-");
}

function collapseSupersededProcessSessions(sessions) {
  const exactLiveLocations = new Set();
  for (const session of sessions) {
    if (isProcessDiscoveredSession(session) || session.presence !== "live") continue;
    const identity = sessionTerminalIdentity(session);
    if (identity) exactLiveLocations.add(identity);
  }

  const winners = new Map();
  for (const session of sessions) {
    if (!isProcessDiscoveredSession(session)) continue;
    const identity = sessionTerminalIdentity(session);
    if (!identity || exactLiveLocations.has(identity)) continue;
    const current = winners.get(identity);
    const sessionIsLive = session.presence === "live";
    const currentIsLive = current?.presence === "live";
    if (
      !current ||
      (sessionIsLive && !currentIsLive) ||
      (sessionIsLive === currentIsLive && session.updatedAt > current.updatedAt)
    ) {
      winners.set(identity, session);
    }
  }

  return sessions.filter((session) => {
    if (!isProcessDiscoveredSession(session)) return true;
    const identity = sessionTerminalIdentity(session);
    if (!identity) return true;
    if (exactLiveLocations.has(identity)) return false;
    return winners.get(identity)?.id === session.id;
  });
}

export class SwitchboardStore extends EventEmitter {
  constructor(dbPath) {
    super();
    if (dbPath !== ":memory:") mkdirSync(path.dirname(dbPath), { recursive: true, mode: 0o700 });
    this.dbPath = dbPath;
    this.db = new DatabaseSync(dbPath);
    this.db.exec("PRAGMA foreign_keys = ON");
    this.db.exec("PRAGMA busy_timeout = 3000");
    this.db.exec("PRAGMA journal_mode = WAL");
    this.#migrate();
    this.#prepare();
  }

  #migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        harness TEXT NOT NULL,
        nativeSessionId TEXT NOT NULL,
        title TEXT NOT NULL,
        cwd TEXT,
        project TEXT,
        branch TEXT,
        presence TEXT NOT NULL,
        activity TEXT NOT NULL,
        attention TEXT NOT NULL,
        attentionKind TEXT,
        attentionRequestId TEXT,
        attentionSummary TEXT,
        unread INTEGER NOT NULL DEFAULT 0,
        errorKind TEXT,
        errorSummary TEXT,
        telemetry TEXT NOT NULL,
        confidence REAL NOT NULL,
        pid INTEGER,
        terminal TEXT,
        terminalKind TEXT,
        terminalTarget TEXT,
        terminalInstance TEXT,
        startedAt INTEGER NOT NULL,
        lastActivityAt INTEGER NOT NULL,
        completedAt INTEGER,
        seenAt INTEGER,
        endedAt INTEGER,
        completionSeq INTEGER NOT NULL DEFAULT 0,
        seenSeq INTEGER NOT NULL DEFAULT 0,
        dismissed INTEGER NOT NULL DEFAULT 0,
        lastEventType TEXT NOT NULL,
        lastEventAt INTEGER NOT NULL,
        createdAt INTEGER NOT NULL,
        updatedAt INTEGER NOT NULL,
        UNIQUE(harness, nativeSessionId)
      );

      CREATE INDEX IF NOT EXISTS sessions_priority_idx
        ON sessions(presence, unread, attention, errorKind, updatedAt DESC);
      CREATE INDEX IF NOT EXISTS sessions_process_idx ON sessions(harness, pid);

      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        dedupeKey TEXT NOT NULL UNIQUE,
        sessionId TEXT NOT NULL,
        harness TEXT NOT NULL,
        kind TEXT NOT NULL,
        nativeType TEXT NOT NULL,
        summary TEXT,
        occurredAt INTEGER NOT NULL,
        receivedAt INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS events_session_idx
        ON events(sessionId, occurredAt DESC, id DESC);

      CREATE TABLE IF NOT EXISTS adapter_health (
        adapter TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        version TEXT,
        detail TEXT,
        checkedAt INTEGER NOT NULL
      );
    `);

    const sessionColumns = new Set(this.db.prepare("PRAGMA table_info(sessions)").all().map((column) => column.name));
    for (const [column, type] of [
      ["terminalKind", "TEXT"],
      ["terminalTarget", "TEXT"],
      ["terminalInstance", "TEXT"],
    ]) {
      if (!sessionColumns.has(column)) this.db.exec(`ALTER TABLE sessions ADD COLUMN ${column} ${type}`);
    }

    this.db
      .prepare(
        `INSERT INTO meta(key, value) VALUES ('schemaVersion', '2')
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      )
      .run();
    this.db
      .prepare("INSERT OR IGNORE INTO meta(key, value) VALUES ('installedAt', ?)")
      .run(String(Date.now()));
  }

  #prepare() {
    const insertColumns = SESSION_COLUMNS.join(", ");
    const values = SESSION_COLUMNS.map((column) => `@${column}`).join(", ");
    const updates = SESSION_COLUMNS.filter((column) => column !== "id")
      .map((column) => `${column} = excluded.${column}`)
      .join(", ");

    this.upsertSessionStatement = this.db.prepare(
      `INSERT INTO sessions (${insertColumns}) VALUES (${values})
       ON CONFLICT(id) DO UPDATE SET ${updates}`,
    );
    this.getSessionStatement = this.db.prepare("SELECT * FROM sessions WHERE id = ?");
    this.getProvisionalByPidStatement = this.db.prepare(
      `SELECT * FROM sessions
       WHERE harness = ? AND pid = ? AND nativeSessionId LIKE 'process-%' AND id != ?
       ORDER BY updatedAt DESC LIMIT 1`,
    );
    this.insertEventStatement = this.db.prepare(
      `INSERT OR IGNORE INTO events
       (dedupeKey, sessionId, harness, kind, nativeType, summary, occurredAt, receivedAt)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
  }

  close() {
    this.db.close();
  }

  ingest(input) {
    const event = normalizeEvent(input);
    const dedupeKey = `${event.harness}:${event.eventId}`;
    let session;

    this.db.exec("BEGIN IMMEDIATE");
    try {
      const inserted = this.insertEventStatement.run(
        dedupeKey,
        event.sessionKey,
        event.harness,
        event.kind,
        event.nativeType,
        eventSummary(event),
        event.occurredAt,
        event.receivedAt,
      );
      if (Number(inserted.changes) === 0) {
        this.db.exec("COMMIT");
        return { accepted: false, duplicate: true, session: this.getSession(event.sessionKey) };
      }

      let previous = this.getSession(event.sessionKey);
      if (!previous && event.metadata.pid) {
        const provisional = fromDatabaseSession(
          this.getProvisionalByPidStatement.get(event.harness, event.metadata.pid, event.sessionKey),
        );
        if (provisional) {
          previous = {
            ...provisional,
            id: event.sessionKey,
            nativeSessionId: event.nativeSessionId,
          };
          this.db.prepare("UPDATE events SET sessionId = ? WHERE sessionId = ?").run(event.sessionKey, provisional.id);
          this.db.prepare("DELETE FROM sessions WHERE id = ?").run(provisional.id);
        }
      }

      session = reduceSession(previous, event);
      this.upsertSessionStatement.run(toDatabaseSession(session));
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }

    const decorated = decorateSession(session);
    this.emit("changed", { type: "session.changed", session: decorated });
    return { accepted: true, duplicate: false, session: decorated };
  }

  getSession(id) {
    return fromDatabaseSession(this.getSessionStatement.get(id));
  }

  resolveSessionForPid(harness, pid) {
    const row = this.db
      .prepare(
        `SELECT id FROM sessions WHERE harness = ? AND pid = ?
         ORDER BY CASE WHEN presence = 'live' THEN 0 ELSE 1 END,
                  CASE WHEN nativeSessionId LIKE 'process-%' THEN 1 ELSE 0 END,
                  updatedAt DESC
         LIMIT 1`,
      )
      .get(harness, pid);
    return row?.id || null;
  }

  listLivePidSessions() {
    return this.db
      .prepare(
        `SELECT * FROM sessions
         WHERE presence = 'live' AND pid IS NOT NULL`,
      )
      .all()
      .map(fromDatabaseSession);
  }

  listSessions({ recentHours = 24, maxRecent = 20, now = Date.now() } = {}) {
    const sessions = this.db
      .prepare("SELECT * FROM sessions")
      .all()
      .map(fromDatabaseSession)
      .filter((session) => shouldIncludeSession(session, now, recentHours));

    const sorted = sortSessions(collapseSupersededProcessSessions(sessions)).map(decorateSession);
    let recentCount = 0;
    return sorted.filter((session) => {
      if (session.group !== "recent") return true;
      recentCount += 1;
      return recentCount <= maxRecent;
    });
  }

  getSnapshot(options = {}) {
    const sessions = this.listSessions(options);
    const counts = {
      total: sessions.length,
      needsYou: sessions.filter((session) => session.primaryState === "needs_attention").length,
      working: sessions.filter((session) => session.primaryState === "working").length,
      open: sessions.filter((session) => session.presence === "live").length,
      unread: sessions.filter((session) => session.primaryState === "unread").length,
      errors: sessions.filter((session) => session.primaryState === "error").length,
    };
    return { generatedAt: Date.now(), counts, sessions };
  }

  getSessionDetail(id, eventLimit = 40) {
    const session = this.getSession(id);
    if (!session) return null;
    const events = this.db
      .prepare(
        `SELECT kind, nativeType, summary, occurredAt, receivedAt
         FROM events WHERE sessionId = ?
         ORDER BY occurredAt DESC, id DESC LIMIT ?`,
      )
      .all(id, eventLimit);
    return { session: decorateSession(session), events };
  }

  markSeen(id, now = Date.now()) {
    const result = this.db
      .prepare(
        `UPDATE sessions
         SET seenSeq = completionSeq, unread = 0, seenAt = ?, dismissed = 0
         WHERE id = ?`,
      )
      .run(now, id);
    if (!result.changes) return null;
    const session = decorateSession(this.getSession(id));
    this.emit("changed", { type: "session.seen", session });
    return session;
  }

  markUnread(id, now = Date.now()) {
    const result = this.db
      .prepare(
        `UPDATE sessions
         SET seenSeq = CASE WHEN completionSeq > 0 THEN completionSeq - 1 ELSE 0 END,
             unread = 1, seenAt = ?, dismissed = 0
         WHERE id = ?`,
      )
      .run(now, id);
    if (!result.changes) return null;
    const session = decorateSession(this.getSession(id));
    this.emit("changed", { type: "session.unread", session });
    return session;
  }

  dismiss(id) {
    const result = this.db.prepare("UPDATE sessions SET dismissed = 1 WHERE id = ?").run(id);
    if (!result.changes) return null;
    const session = decorateSession(this.getSession(id));
    this.emit("changed", { type: "session.dismissed", session });
    return session;
  }

  clearDemoData() {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const sessions = this.db
        .prepare(
          `DELETE FROM sessions
           WHERE id IN (SELECT DISTINCT sessionId FROM events WHERE nativeType LIKE 'demo.%')`,
        )
        .run();
      const events = this.db.prepare("DELETE FROM events WHERE nativeType LIKE 'demo.%'").run();
      const adapters = this.db
        .prepare("DELETE FROM adapter_health WHERE detail LIKE 'Last event: demo.%'")
        .run();
      this.db.exec("COMMIT");
      const result = {
        sessions: Number(sessions.changes),
        events: Number(events.changes),
        adapters: Number(adapters.changes),
      };
      if (result.sessions || result.events || result.adapters) {
        this.emit("changed", { type: "demo.cleared", ...result });
      }
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  setAdapterHealth(adapter, { status, version = null, detail = null, checkedAt = Date.now() }) {
    this.db
      .prepare(
        `INSERT INTO adapter_health(adapter, status, version, detail, checkedAt)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(adapter) DO UPDATE SET
           status = excluded.status,
           version = excluded.version,
           detail = excluded.detail,
           checkedAt = excluded.checkedAt`,
      )
      .run(adapter, status, version, detail, checkedAt);
    this.emit("changed", { type: "adapter.changed", adapter });
  }

  listAdapterHealth() {
    return this.db.prepare("SELECT * FROM adapter_health ORDER BY adapter").all();
  }

  clearForTests() {
    this.db.exec("DELETE FROM events; DELETE FROM sessions; DELETE FROM adapter_health;");
    this.emit("changed", { type: "store.cleared" });
  }
}
