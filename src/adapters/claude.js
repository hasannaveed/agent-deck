import { EVENT_KINDS } from "../domain.js";
import {
  baseEvent,
  eventType,
  hasRunningBackgroundWork,
  requestIdentifier,
  toolLabel,
} from "./common.js";

export function translateClaudeEvent(raw, context = {}) {
  const type = eventType(raw);
  const events = [];
  const add = (overrides) => {
    const event = baseEvent("claude", raw, context, overrides);
    if (event) events.push(event);
  };

  if (type === "SessionStart") {
    add({ kind: EVENT_KINDS.SESSION_STARTED });
  } else if (type === "UserPromptSubmit") {
    add({ kind: EVENT_KINDS.WORK_STARTED, humanInitiated: true });
  } else if (type === "PermissionRequest") {
    add({
      kind: EVENT_KINDS.ATTENTION_REQUESTED,
      attention: {
        kind: "approval",
        requestId: requestIdentifier(raw),
        summary: `Approval requested for ${toolLabel(raw)}`,
      },
    });
  } else if (type === "PreToolUse") {
    const tool = toolLabel(raw).toLowerCase();
    if (tool === "askuserquestion" || tool.includes("request_user_input")) {
      add({
        kind: EVENT_KINDS.ATTENTION_REQUESTED,
        attention: { kind: "question", requestId: requestIdentifier(raw), summary: "Claude Code has a question" },
      });
    }
  } else if (type === "Notification") {
    const notificationType = String(raw?.notification_type || "");
    if (notificationType === "permission_prompt") {
      add({
        kind: EVENT_KINDS.ATTENTION_REQUESTED,
        attention: { kind: "approval", summary: "Claude Code is waiting for approval" },
      });
    } else if (notificationType === "idle_prompt") {
      add({
        kind: EVENT_KINDS.WORK_COMPLETED,
        completion: { outcome: "completed", summary: "Claude Code finished the turn" },
      });
    } else if (notificationType === "elicitation_dialog") {
      add({
        kind: EVENT_KINDS.ATTENTION_REQUESTED,
        attention: { kind: "elicitation", summary: "Claude Code is requesting external input" },
      });
    } else if (["auth_success", "elicitation_complete", "elicitation_response"].includes(notificationType)) {
      add({ kind: EVENT_KINDS.ATTENTION_RESOLVED });
    }
  } else if (type === "Elicitation") {
    add({
      kind: EVENT_KINDS.ATTENTION_REQUESTED,
      attention: { kind: "elicitation", requestId: requestIdentifier(raw), summary: "Claude Code is requesting external input" },
    });
  } else if (["PostToolUse", "PostToolUseFailure", "PermissionDenied", "ElicitationResult"].includes(type)) {
    add({ kind: EVENT_KINDS.ATTENTION_RESOLVED });
  } else if (type === "Stop") {
    if (hasRunningBackgroundWork(raw)) {
      add({ kind: EVENT_KINDS.WORK_STARTED });
    } else {
      add({
        kind: EVENT_KINDS.WORK_COMPLETED,
        completion: { outcome: "completed", summary: "Claude Code finished the turn" },
      });
    }
  } else if (type === "StopFailure") {
    const failure = String(raw?.error || "claude_error");
    if (/interrupt|abort|cancel/i.test(failure)) {
      add({ kind: EVENT_KINDS.WORK_INTERRUPTED });
    } else {
      add({
        kind: EVENT_KINDS.SESSION_ERROR,
        error: {
          kind: failure,
          summary: `Claude Code stopped: ${failure.replaceAll("_", " ")}`,
        },
      });
    }
  } else if (type === "SessionEnd") {
    add({ kind: EVENT_KINDS.SESSION_ENDED });
  }

  return events;
}
