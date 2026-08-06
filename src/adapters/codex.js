import { EVENT_KINDS } from "../domain.js";
import { baseEvent, eventPayload, eventType, requestIdentifier, toolLabel } from "./common.js";

function requestKind(type, raw) {
  if (type.includes("requestUserInput")) return "question";
  if (type.includes("elicitation")) return "elicitation";
  if (type.includes("permissions")) return "approval";
  const tool = toolLabel(raw).toLowerCase();
  return tool.includes("request_user_input") || tool.includes("askuser") ? "question" : "approval";
}

export function translateCodexEvent(raw, context = {}) {
  const type = eventType(raw);
  const payload = eventPayload(raw);
  const events = [];
  const add = (overrides) => {
    const event = baseEvent("codex", raw, context, overrides);
    if (event) events.push(event);
  };

  if (type === "SessionStart" || type === "thread/started") {
    add({ kind: EVENT_KINDS.SESSION_STARTED });
  } else if (type === "UserPromptSubmit" || type === "turn/started") {
    add({ kind: EVENT_KINDS.WORK_STARTED, humanInitiated: type === "UserPromptSubmit" });
  } else if (
    type === "PermissionRequest" ||
    type.endsWith("/requestApproval") ||
    ["tool/requestUserInput", "item/tool/requestUserInput"].includes(type) ||
    type === "mcpServer/elicitation/request"
  ) {
    const kind = requestKind(type, raw);
    add({
      kind: EVENT_KINDS.ATTENTION_REQUESTED,
      attention: {
        kind,
        requestId: requestIdentifier(raw),
        summary:
          kind === "question"
            ? "Codex has a question"
            : kind === "elicitation"
              ? "Codex is requesting external input"
              : `Approval requested for ${toolLabel(raw)}`,
      },
    });
  } else if (type === "PreToolUse") {
    const tool = toolLabel(raw).toLowerCase();
    if (tool.includes("request_user_input") || tool.includes("askuser")) {
      add({
        kind: EVENT_KINDS.ATTENTION_REQUESTED,
        attention: {
          kind: "question",
          requestId: requestIdentifier(raw),
          summary: "Codex has a question",
        },
      });
    }
  } else if (type === "PostToolUse" || type === "serverRequest/resolved") {
    add({ kind: EVENT_KINDS.ATTENTION_RESOLVED });
  } else if (type === "Stop" || type === "turn/completed") {
    const turn = payload?.turn || payload;
    const failed = turn?.status === "failed" || Boolean(turn?.error);
    if (failed) {
      add({
        kind: EVENT_KINDS.SESSION_ERROR,
        error: {
          kind: turn?.error?.codexErrorInfo || "turn_failed",
          summary: turn?.error?.message || "Codex could not complete the turn",
        },
      });
    } else {
      add({
        kind: EVENT_KINDS.WORK_COMPLETED,
        completion: { outcome: "completed", summary: "Codex finished the turn" },
      });
    }
  } else if (type === "error") {
    add({
      kind: EVENT_KINDS.SESSION_ERROR,
      error: {
        kind: payload?.error?.codexErrorInfo || "codex_error",
        summary: payload?.error?.message || "Codex reported an error",
      },
    });
  } else if (type === "thread/status/changed") {
    const status = payload?.status || {};
    if (status.type === "active" && status.activeFlags?.includes("waitingOnApproval")) {
      add({
        kind: EVENT_KINDS.ATTENTION_REQUESTED,
        attention: { kind: "approval", summary: "Codex is waiting for approval" },
      });
    } else if (status.type === "active") {
      add({ kind: EVENT_KINDS.WORK_STARTED });
    } else if (status.type === "idle") {
      add({ kind: EVENT_KINDS.ACTIVITY_IDLE });
    } else if (status.type === "notLoaded") {
      add({ kind: EVENT_KINDS.SESSION_ENDED });
    }
  } else if (type === "SessionEnd" || type === "thread/closed") {
    add({ kind: EVENT_KINDS.SESSION_ENDED });
  }

  return events;
}
