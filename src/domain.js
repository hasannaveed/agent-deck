import { createHash, randomUUID } from "node:crypto";

export const HARNESSES = Object.freeze(["codex", "claude", "opencode"]);

export const EVENT_KINDS = Object.freeze({
  SESSION_STARTED: "session_started",
  PROCESS_SEEN: "process_seen",
  PROCESS_GONE: "process_gone",
  WORK_STARTED: "work_started",
  ACTIVITY_IDLE: "activity_idle",
  ATTENTION_REQUESTED: "attention_requested",
  ATTENTION_RESOLVED: "attention_resolved",
  WORK_COMPLETED: "work_completed",
  SESSION_ERROR: "session_error",
  SESSION_ENDED: "session_ended",
});

const EVENT_KIND_SET = new Set(Object.values(EVENT_KINDS));
const HARNESS_SET = new Set(HARNESSES);
const TELEMETRY_SET = new Set(["native", "hook", "process", "derived"]);
const ATTENTION_SET = new Set(["approval", "question", "authentication", "elicitation", "input"]);

export function sanitizeText(value, maxLength = 240) {
  if (value === undefined || value === null) return null;
  const text = String(value)
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return text ? text.slice(0, maxLength) : null;
}

export function sanitizePath(value) {
  if (value === undefined || value === null) return null;
  const text = String(value).replace(/[\u0000\r\n]/g, "").trim();
  return text ? text.slice(0, 2048) : null;
}

export function createSessionKey(harness, nativeSessionId) {
  const digest = createHash("sha256")
    .update(`${harness}\0${nativeSessionId}`)
    .digest("hex")
    .slice(0, 24);
  return `${harness}:${digest}`;
}

function normalizeTimestamp(value) {
  if (value === undefined || value === null) return Date.now();
  const parsed = typeof value === "string" ? Date.parse(value) : Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return Date.now();
  return Math.min(parsed, Date.now() + 5 * 60_000);
}

export function normalizeEvent(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new TypeError("Event must be a JSON object");
  }

  const harness = sanitizeText(input.harness, 32)?.toLowerCase();
  if (!HARNESS_SET.has(harness)) throw new TypeError(`Unsupported harness: ${input.harness}`);

  const kind = sanitizeText(input.kind, 64)?.toLowerCase();
  if (!EVENT_KIND_SET.has(kind)) throw new TypeError(`Unsupported event kind: ${input.kind}`);

  const nativeSessionId = sanitizeText(input.nativeSessionId, 512);
  if (!nativeSessionId) throw new TypeError("nativeSessionId is required");

  const metadata = input.metadata && typeof input.metadata === "object" ? input.metadata : {};
  const attention = input.attention && typeof input.attention === "object" ? input.attention : {};
  const error = input.error && typeof input.error === "object" ? input.error : {};
  const completion = input.completion && typeof input.completion === "object" ? input.completion : {};
  const telemetry = TELEMETRY_SET.has(input.telemetry) ? input.telemetry : "hook";
  const attentionKind = ATTENTION_SET.has(attention.kind) ? attention.kind : "input";

  return {
    schemaVersion: 1,
    eventId: sanitizeText(input.eventId, 512) || randomUUID(),
    harness,
    nativeSessionId,
    sessionKey: createSessionKey(harness, nativeSessionId),
    kind,
    nativeType: sanitizeText(input.nativeType, 128) || kind,
    occurredAt: normalizeTimestamp(input.occurredAt),
    receivedAt: Date.now(),
    telemetry,
    confidence: Math.max(0, Math.min(1, Number(input.confidence ?? (telemetry === "process" ? 0.45 : 1)))),
    humanInitiated: Boolean(input.humanInitiated),
    metadata: {
      title: sanitizeText(metadata.title, 160),
      cwd: sanitizePath(metadata.cwd),
      project: sanitizeText(metadata.project, 160),
      branch: sanitizeText(metadata.branch, 240),
      pid: Number.isInteger(Number(metadata.pid)) && Number(metadata.pid) > 0 ? Number(metadata.pid) : null,
      terminal: sanitizeText(metadata.terminal, 160),
      terminalKind: sanitizeText(metadata.terminalKind, 32)?.toLowerCase() || null,
      terminalTarget: sanitizeText(metadata.terminalTarget, 256),
      terminalInstance: sanitizePath(metadata.terminalInstance),
      startedAt: metadata.startedAt ? normalizeTimestamp(metadata.startedAt) : null,
    },
    attention: {
      kind: attentionKind,
      requestId: sanitizeText(attention.requestId, 256),
      summary: sanitizeText(attention.summary, 240),
    },
    error: {
      kind: sanitizeText(error.kind, 96) || "unknown",
      summary: sanitizeText(error.summary, 360),
    },
    completion: {
      outcome: completion.outcome === "failed" ? "failed" : "completed",
      summary: sanitizeText(completion.summary, 360),
    },
  };
}

export function displayHarness(harness) {
  if (harness === "codex") return "Codex";
  if (harness === "claude") return "Claude Code";
  if (harness === "opencode") return "OpenCode";
  return harness;
}
