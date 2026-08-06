import assert from "node:assert/strict";
import test from "node:test";
import { translateClaudeEvent } from "../src/adapters/claude.js";
import { translateCodexEvent } from "../src/adapters/codex.js";
import { translateOpenCodeEvent } from "../src/adapters/opencode.js";

test("Codex app-server events map to work and approval signals", () => {
  const started = translateCodexEvent({ method: "turn/started", params: { threadId: "thread-1" } });
  assert.equal(started[0].kind, "work_started");
  assert.equal(started[0].nativeSessionId, "thread-1");

  const approval = translateCodexEvent({
    method: "item/commandExecution/requestApproval",
    params: { threadId: "thread-1", requestId: "approval-1" },
  });
  assert.equal(approval[0].kind, "attention_requested");
  assert.equal(approval[0].attention.kind, "approval");
  assert.equal(approval[0].attention.requestId, "approval-1");

  const question = translateCodexEvent({
    method: "item/tool/requestUserInput",
    params: { threadId: "thread-1", requestId: "question-1" },
  });
  assert.equal(question[0].kind, "attention_requested");
  assert.equal(question[0].attention.kind, "question");

  const correlated = translateCodexEvent(
    { method: "turn/started", params: { turn: { id: "turn-1" } } },
    { nativeSessionId: "thread-1" },
  );
  assert.equal(correlated[0].nativeSessionId, "thread-1");
});

test("Claude hooks distinguish questions, completion, and failure", () => {
  const question = translateClaudeEvent({
    hook_event_name: "PreToolUse",
    session_id: "claude-1",
    tool_name: "AskUserQuestion",
    tool_use_id: "tool-1",
  });
  assert.equal(question[0].kind, "attention_requested");
  assert.equal(question[0].attention.kind, "question");

  const completed = translateClaudeEvent({ hook_event_name: "Stop", session_id: "claude-1" });
  assert.equal(completed[0].kind, "work_completed");

  const failed = translateClaudeEvent({
    hook_event_name: "StopFailure",
    session_id: "claude-1",
    error: "api_error",
  });
  assert.equal(failed[0].kind, "session_error");
  assert.match(failed[0].error.summary, /api error/);

  const toolFailure = translateClaudeEvent({
    hook_event_name: "PostToolUseFailure",
    session_id: "claude-1",
    tool_name: "Bash",
  });
  assert.equal(toolFailure[0].kind, "attention_resolved");
});

test("OpenCode plugin events map busy, idle, permission, and error states", () => {
  const context = { telemetry: "native" };
  const busy = translateOpenCodeEvent(
    { event: { type: "session.status", properties: { sessionID: "open-1", status: { type: "busy" } } } },
    context,
  );
  const idle = translateOpenCodeEvent(
    { event: { type: "session.idle", properties: { sessionID: "open-1" } } },
    context,
  );
  const permission = translateOpenCodeEvent(
    { event: { type: "permission.asked", properties: { sessionID: "open-1", id: "permission-1" } } },
    context,
  );
  const error = translateOpenCodeEvent(
    {
      event: {
        type: "session.error",
        properties: { sessionID: "open-1", error: { name: "ProviderError" } },
      },
    },
    context,
  );

  assert.equal(busy[0].kind, "work_started");
  assert.equal(idle[0].kind, "work_completed");
  assert.equal(permission[0].kind, "attention_requested");
  assert.equal(error[0].error.kind, "ProviderError");
});

test("adapter events without a stable session id are ignored", () => {
  assert.deepEqual(translateCodexEvent({ method: "turn/started", params: {} }), []);
  assert.deepEqual(translateClaudeEvent({ hook_event_name: "Stop" }), []);
  assert.deepEqual(translateOpenCodeEvent({ event: { type: "session.idle", properties: {} } }), []);
});

test("hook adapters do not forward prompt or tool payload content", () => {
  const secret = "DO_NOT_PERSIST_THIS_PROMPT_OR_COMMAND";
  const prompt = translateClaudeEvent({
    hook_event_name: "UserPromptSubmit",
    session_id: "private-session",
    prompt: secret,
    cwd: "/work/private",
  });
  const tool = translateCodexEvent({
    hook_event_name: "PreToolUse",
    session_id: "private-session",
    tool_name: "request_user_input",
    tool_input: { command: secret, question: secret },
  });

  assert.equal(JSON.stringify(prompt).includes(secret), false);
  assert.equal(JSON.stringify(tool).includes(secret), false);
});
