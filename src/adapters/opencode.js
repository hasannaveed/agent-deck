import { EVENT_KINDS } from "../domain.js";
import { baseEvent, eventPayload, eventType, requestIdentifier } from "./common.js";

export function translateOpenCodeEvent(raw, context = {}) {
  const type = eventType(raw);
  const payload = eventPayload(raw);
  const events = [];
  const add = (overrides) => {
    const event = baseEvent("opencode", raw, { ...context, telemetry: context.telemetry || "native" }, overrides);
    if (event) events.push(event);
  };

  if (type === "session.created") {
    add({ kind: EVENT_KINDS.SESSION_STARTED });
  } else if (type === "session.updated") {
    add({ kind: EVENT_KINDS.PROCESS_SEEN });
  } else if (type === "session.deleted") {
    add({ kind: EVENT_KINDS.SESSION_ENDED });
  } else if (type === "session.status") {
    const status = payload?.status || {};
    if (["busy", "retry"].includes(status.type)) add({ kind: EVENT_KINDS.WORK_STARTED });
    else if (status.type === "idle") add({ kind: EVENT_KINDS.ACTIVITY_IDLE });
  } else if (type === "session.idle") {
    add({
      kind: EVENT_KINDS.WORK_COMPLETED,
      completion: { outcome: "completed", summary: "OpenCode finished the turn" },
    });
  } else if (type === "session.error") {
    const errorType = payload?.error?.name || payload?.error?.type || "opencode_error";
    add({
      kind: EVENT_KINDS.SESSION_ERROR,
      error: { kind: errorType, summary: "OpenCode reported a session error" },
    });
  } else if (["permission.asked", "permission.updated", "permission.v2.asked"].includes(type)) {
    add({
      kind: EVENT_KINDS.ATTENTION_REQUESTED,
      attention: { kind: "approval", requestId: requestIdentifier(raw), summary: "OpenCode is waiting for approval" },
    });
  } else if (["permission.replied", "permission.v2.replied"].includes(type)) {
    add({ kind: EVENT_KINDS.ATTENTION_RESOLVED });
  } else if (["question.asked", "question.v2.asked"].includes(type)) {
    add({
      kind: EVENT_KINDS.ATTENTION_REQUESTED,
      attention: { kind: "question", requestId: requestIdentifier(raw), summary: "OpenCode has a question" },
    });
  } else if (["question.replied", "question.rejected", "question.v2.replied", "question.v2.rejected"].includes(type)) {
    add({ kind: EVENT_KINDS.ATTENTION_RESOLVED });
  }

  return events;
}
