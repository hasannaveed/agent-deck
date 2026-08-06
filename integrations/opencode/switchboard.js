import { spawn } from "node:child_process";

const trackedEvents = new Set([
  "session.created",
  "session.updated",
  "session.deleted",
  "session.status",
  "session.idle",
  "session.error",
  "permission.asked",
  "permission.updated",
  "permission.replied",
  "permission.v2.asked",
  "permission.v2.replied",
  "question.asked",
  "question.replied",
  "question.rejected",
  "question.v2.asked",
  "question.v2.replied",
  "question.v2.rejected"
]);

function forward(event) {
  const child = spawn("switchboardctl", ["emit", "--harness", "opencode"], {
    detached: true,
    stdio: ["pipe", "ignore", "ignore"]
  });
  child.on("error", () => {});
  child.stdin.on("error", () => {});
  child.stdin.end(JSON.stringify(event));
  child.unref();
}

export const AgentSwitchboard = async () => ({
  event: async ({ event }) => {
    if (trackedEvents.has(event.type)) forward(event);
  }
});
