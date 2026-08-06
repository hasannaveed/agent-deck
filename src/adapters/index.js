import { translateClaudeEvent } from "./claude.js";
import { translateCodexEvent } from "./codex.js";
import { translateOpenCodeEvent } from "./opencode.js";

export function translateHarnessEvent(harness, raw, context = {}) {
  if (harness === "codex") return translateCodexEvent(raw, context);
  if (harness === "claude") return translateClaudeEvent(raw, context);
  if (harness === "opencode") return translateOpenCodeEvent(raw, context);
  throw new TypeError(`Unsupported harness: ${harness}`);
}
