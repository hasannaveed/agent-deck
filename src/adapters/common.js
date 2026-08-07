import path from "node:path";
import { randomUUID } from "node:crypto";
import { sanitizeText } from "../domain.js";

export function eventType(raw) {
  return raw?.hook_event_name || raw?.method || raw?.type || raw?.event?.type || "unknown";
}

export function eventPayload(raw) {
  return raw?.params || raw?.properties || raw?.data || raw?.event?.properties || raw?.event?.data || {};
}

export function nativeSessionId(raw) {
  const payload = eventPayload(raw);
  return sanitizeText(
    raw?.session_id ||
      raw?.sessionID ||
      raw?.thread_id ||
      raw?.threadId ||
      payload?.sessionID ||
      payload?.sessionId ||
      payload?.threadId ||
      payload?.thread?.id ||
      payload?.info?.id,
    512,
  );
}

function eventIdentifier(raw, type, sessionId) {
  const durable = raw?.durable || raw?.properties?.durable || raw?.data?.durable;
  if (raw?.id !== undefined && raw?.id !== null) return `${type}:${raw.id}`;
  if (durable?.aggregateID && durable?.seq !== undefined) {
    return `${type}:${durable.aggregateID}:${durable.seq}`;
  }
  return `${type}:${sessionId}:${randomUUID()}`;
}

export function baseEvent(harness, raw, context = {}, overrides = {}) {
  const type = eventType(raw);
  const payload = eventPayload(raw);
  const sessionId = overrides.nativeSessionId || nativeSessionId(raw) || sanitizeText(context.nativeSessionId, 512);
  if (!sessionId) return null;

  const info = payload?.info || payload?.thread || {};
  const cwd =
    raw?.cwd ||
    raw?.directory ||
    payload?.cwd ||
    payload?.directory ||
    info?.cwd ||
    info?.directory ||
    context.cwd ||
    null;
  const title =
    raw?.session_title ||
    raw?.sessionTitle ||
    payload?.title ||
    info?.name ||
    info?.title ||
    null;

  return {
    schemaVersion: 1,
    eventId: overrides.eventId || eventIdentifier(raw, type, sessionId),
    harness,
    nativeSessionId: sessionId,
    kind: overrides.kind,
    nativeType: type,
    occurredAt: overrides.occurredAt || raw?.timestamp || payload?.timestamp || Date.now(),
    telemetry: overrides.telemetry || context.telemetry || "hook",
    confidence: overrides.confidence ?? context.confidence ?? 1,
    humanInitiated: Boolean(overrides.humanInitiated),
    metadata: {
      title,
      cwd,
      project: cwd ? path.basename(cwd) : null,
      branch: payload?.gitInfo?.branch || payload?.branch || info?.branch || context.branch || null,
      pid: context.pid || null,
      terminal: context.terminal || null,
      terminalKind: context.terminalKind || null,
      terminalTarget: context.terminalTarget || null,
      terminalInstance: context.terminalInstance || null,
      startedAt: info?.createdAt ? Number(info.createdAt) * 1000 : context.startedAt || null,
      ...(overrides.metadata || {}),
    },
    attention: overrides.attention,
    error: overrides.error,
    completion: overrides.completion,
  };
}

export function toolLabel(raw) {
  const payload = eventPayload(raw);
  return sanitizeText(raw?.tool_name || payload?.toolName || payload?.tool || payload?.action, 80) || "a tool";
}

export function requestIdentifier(raw) {
  const payload = eventPayload(raw);
  return sanitizeText(
    raw?.request_id ||
      raw?.tool_use_id ||
      payload?.requestId ||
      payload?.requestID ||
      payload?.permissionID ||
      payload?.itemId ||
      payload?.id,
    256,
  );
}

export function hasRunningBackgroundWork(raw) {
  return Array.isArray(raw?.background_tasks) && raw.background_tasks.some((task) => {
    const status = String(task?.status || "").toLowerCase();
    return !["completed", "failed", "cancelled", "canceled", "stopped"].includes(status);
  });
}
