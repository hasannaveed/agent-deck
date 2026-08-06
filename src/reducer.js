import path from "node:path";
import { displayHarness, EVENT_KINDS } from "./domain.js";

export function createInitialSession(event) {
  const project = event.metadata.project || (event.metadata.cwd ? path.basename(event.metadata.cwd) : null);
  return {
    id: event.sessionKey,
    harness: event.harness,
    nativeSessionId: event.nativeSessionId,
    title: event.metadata.title || project || `${displayHarness(event.harness)} session`,
    cwd: event.metadata.cwd,
    project,
    branch: event.metadata.branch,
    presence: "live",
    activity: "unknown",
    attention: "none",
    attentionKind: null,
    attentionRequestId: null,
    attentionSummary: null,
    unread: false,
    errorKind: null,
    errorSummary: null,
    telemetry: event.telemetry,
    confidence: event.confidence,
    pid: event.metadata.pid,
    terminal: event.metadata.terminal,
    terminalKind: event.metadata.terminalKind,
    terminalTarget: event.metadata.terminalTarget,
    terminalInstance: event.metadata.terminalInstance,
    startedAt: event.metadata.startedAt || event.occurredAt,
    lastActivityAt: event.occurredAt,
    completedAt: null,
    seenAt: event.occurredAt,
    endedAt: null,
    completionSeq: 0,
    seenSeq: 0,
    dismissed: false,
    lastEventType: event.nativeType,
    lastEventAt: event.occurredAt,
    createdAt: event.receivedAt,
    updatedAt: event.occurredAt,
  };
}

function mergeMetadata(session, event) {
  const metadata = event.metadata;
  if (metadata.title) session.title = metadata.title;
  if (metadata.cwd) session.cwd = metadata.cwd;
  if (metadata.project) session.project = metadata.project;
  else if (!session.project && metadata.cwd) session.project = path.basename(metadata.cwd);
  if (metadata.branch) session.branch = metadata.branch;
  if (metadata.pid) session.pid = metadata.pid;
  if (metadata.terminal) session.terminal = metadata.terminal;
  if (metadata.terminalKind) session.terminalKind = metadata.terminalKind;
  if (metadata.terminalTarget) session.terminalTarget = metadata.terminalTarget;
  if (metadata.terminalInstance) session.terminalInstance = metadata.terminalInstance;
  if (metadata.startedAt) session.startedAt = Math.min(session.startedAt || metadata.startedAt, metadata.startedAt);

  if (event.telemetry !== "process" || session.telemetry === "process") {
    session.telemetry = event.telemetry;
    session.confidence = event.confidence;
  }
}

function clearAttention(session) {
  session.attention = "none";
  session.attentionKind = null;
  session.attentionRequestId = null;
  session.attentionSummary = null;
}

function clearError(session) {
  session.errorKind = null;
  session.errorSummary = null;
}

export function reduceSession(previous, event) {
  const session = previous ? { ...previous } : createInitialSession(event);
  mergeMetadata(session, event);
  session.dismissed = false;
  session.lastEventType = event.nativeType;
  session.lastEventAt = event.occurredAt;

  switch (event.kind) {
    case EVENT_KINDS.SESSION_STARTED:
      session.presence = "live";
      session.activity = session.activity === "working" ? "working" : "idle";
      session.endedAt = null;
      break;

    case EVENT_KINDS.PROCESS_SEEN:
      session.presence = "live";
      session.endedAt = null;
      break;

    case EVENT_KINDS.WORK_STARTED:
      session.presence = "live";
      session.activity = "working";
      session.endedAt = null;
      clearAttention(session);
      clearError(session);
      if (event.humanInitiated) {
        session.seenSeq = session.completionSeq;
        session.unread = false;
        session.seenAt = event.occurredAt;
      }
      session.lastActivityAt = event.occurredAt;
      break;

    case EVENT_KINDS.ACTIVITY_IDLE:
      session.presence = "live";
      session.activity = "idle";
      session.lastActivityAt = event.occurredAt;
      break;

    case EVENT_KINDS.ATTENTION_REQUESTED:
      session.presence = "live";
      session.activity = "working";
      session.attention = "required";
      session.attentionKind = event.attention.kind;
      session.attentionRequestId = event.attention.requestId;
      session.attentionSummary = event.attention.summary || "Human input requested";
      session.lastActivityAt = event.occurredAt;
      break;

    case EVENT_KINDS.ATTENTION_RESOLVED:
      clearAttention(session);
      session.activity = "working";
      session.seenSeq = session.completionSeq;
      session.unread = false;
      session.seenAt = event.occurredAt;
      session.lastActivityAt = event.occurredAt;
      break;

    case EVENT_KINDS.WORK_COMPLETED:
      session.presence = "live";
      session.activity = "idle";
      clearAttention(session);
      session.completionSeq += 1;
      session.completedAt = event.occurredAt;
      session.lastActivityAt = event.occurredAt;
      session.unread = session.completionSeq > session.seenSeq;
      if (event.completion.outcome === "failed") {
        session.errorKind = "turn_failed";
        session.errorSummary = event.completion.summary || "The turn failed";
      } else {
        clearError(session);
      }
      break;

    case EVENT_KINDS.SESSION_ERROR:
      session.activity = "idle";
      clearAttention(session);
      session.completionSeq += 1;
      session.completedAt = event.occurredAt;
      session.lastActivityAt = event.occurredAt;
      session.unread = true;
      session.errorKind = event.error.kind;
      session.errorSummary = event.error.summary || "The session stopped with an error";
      break;

    case EVENT_KINDS.PROCESS_GONE:
    case EVENT_KINDS.SESSION_ENDED:
      session.presence = "closed";
      session.activity = "idle";
      clearAttention(session);
      session.endedAt = event.occurredAt;
      break;

    default:
      throw new Error(`Unhandled event kind: ${event.kind}`);
  }

  session.updatedAt = Math.max(session.updatedAt || 0, event.occurredAt);
  return session;
}

export function derivePrimaryState(session) {
  if (session.errorKind) return "error";
  if (session.attention === "required") return "needs_attention";
  if (session.activity === "working") return "working";
  if (session.unread) return "unread";
  if (session.presence === "live" && session.activity === "idle") return "idle";
  if (session.presence === "live") return "unknown";
  return "recent";
}

export function deriveGroup(session) {
  const state = derivePrimaryState(session);
  if (["error", "needs_attention", "unread"].includes(state)) return "needs_you";
  if (state === "working") return "working";
  if (["idle", "unknown"].includes(state)) return "open";
  return "recent";
}

const PRIORITY = Object.freeze({
  error: 0,
  needs_attention: 1,
  unread: 2,
  working: 3,
  idle: 4,
  unknown: 5,
  recent: 6,
});

export function decorateSession(session) {
  const primaryState = derivePrimaryState(session);
  const hasProvider =
    ["tmux", "wezterm", "zellij", "gnome-terminal"].includes(session.terminalKind) ||
    (session.terminalKind === "kitty" && Boolean(session.terminalInstance));
  const focusable = session.presence === "live" && hasProvider && Boolean(session.terminalTarget);
  return {
    ...session,
    primaryState,
    group: deriveGroup(session),
    priority: PRIORITY[primaryState],
    focusable,
    focusProvider: focusable ? session.terminalKind : null,
  };
}

export function shouldIncludeSession(session, now, recentHours) {
  if (session.presence === "live") return true;
  if (session.errorKind || session.attention === "required" || session.unread) return !session.dismissed;
  if (session.dismissed) return false;
  return session.updatedAt >= now - recentHours * 60 * 60 * 1000;
}

export function sortSessions(sessions) {
  return [...sessions].sort((left, right) => {
    const a = decorateSession(left);
    const b = decorateSession(right);
    return a.priority - b.priority || b.updatedAt - a.updatedAt || a.title.localeCompare(b.title);
  });
}
