// Agent Switchboard OpenCode integration.
import { spawn } from "node:child_process";

// The installer replaces these two declarations with absolute paths. Keeping
// command-name defaults makes the template usable after `npm link` as well.
const bridgeCommand = "switchboardctl";
const bridgeArguments = ["emit", "--harness", "opencode"];
const nestedHarnessEnvironment = "AGENT_SWITCHBOARD_CHILD";

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

const promptResolvedEvents = new Set([
  "permission.replied",
  "permission.v2.replied",
  "question.replied",
  "question.rejected",
  "question.v2.replied",
  "question.v2.rejected"
]);

function stringValue(value) {
  return typeof value === "string" && value ? value : undefined;
}

// Only lifecycle metadata crosses the plugin boundary. In particular, command
// text, permission patterns, question text, answers, and model output are never
// included in the object sent to Switchboard.
function lifecycleEvent(event) {
  if (!event || typeof event.type !== "string") return null;
  const properties = event.properties || event.data || {};
  const info = properties.info || {};
  const safeInfo = {
    id: stringValue(info.id),
    title: stringValue(info.title),
    directory: stringValue(info.directory),
    createdAt: Number.isFinite(info.createdAt) ? info.createdAt : undefined
  };
  const safeProperties = {
    sessionID: stringValue(properties.sessionID) || stringValue(info.id),
    id: stringValue(properties.id),
    requestID: stringValue(properties.requestID),
    status: stringValue(properties.status?.type) ? { type: properties.status.type } : undefined,
    error:
      stringValue(properties.error?.name) || stringValue(properties.error?.type)
        ? {
            name: stringValue(properties.error?.name),
            type: stringValue(properties.error?.type)
          }
        : undefined,
    info: Object.values(safeInfo).some((value) => value !== undefined) ? safeInfo : undefined
  };
  return {
    id: stringValue(event.id),
    type: event.type,
    properties: safeProperties
  };
}

function forward(event) {
  const safeEvent = lifecycleEvent(event);
  if (!safeEvent) return;
  try {
    const child = spawn(bridgeCommand, bridgeArguments, {
      detached: true,
      stdio: ["pipe", "ignore", process.env.SWITCHBOARD_DEBUG ? "inherit" : "ignore"],
      windowsHide: true
    });
    child.on("error", (error) => {
      if (process.env.SWITCHBOARD_DEBUG) console.error(`[switchboard plugin] ${error.message}`);
    });
    child.on("exit", (code) => {
      if (process.env.SWITCHBOARD_DEBUG && code) {
        console.error(`[switchboard plugin] bridge exited with status ${code}`);
      }
    });
    child.stdin.on("error", (error) => {
      if (process.env.SWITCHBOARD_DEBUG) console.error(`[switchboard plugin] ${error.message}`);
    });
    child.stdin.end(JSON.stringify(safeEvent));
    child.unref();
  } catch {
    // Switchboard must never interfere with OpenCode.
  }
}

// A tool can launch another OpenCode directly or through a detached tmux
// session. tmux only copies selected client variables into an existing server,
// so add our ownership marker to that allowlist without examining the command.
function ensureTmuxForwardsNestedMarker() {
  if (!process.env.TMUX) return;
  try {
    const inspect = spawn("tmux", ["show-options", "-gv", "update-environment"], {
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true
    });
    let output = "";
    inspect.stdout.setEncoding("utf8");
    inspect.stdout.on("data", (chunk) => {
      if (output.length < 16 * 1024) output += chunk;
    });
    inspect.on("error", () => {});
    inspect.on("close", (code) => {
      if (code !== 0 || output.split(/\s+/).includes(nestedHarnessEnvironment)) return;
      try {
        const update = spawn(
          "tmux",
          ["set-option", "-ga", "update-environment", nestedHarnessEnvironment],
          { detached: true, stdio: "ignore", windowsHide: true }
        );
        update.on("error", () => {});
        update.unref();
      } catch {
        // OpenCode must remain usable when tmux is unavailable.
      }
    });
  } catch {
    // OpenCode must remain usable when tmux is unavailable.
  }
}

function pendingRequests(response) {
  const value = response?.data ?? response;
  if (Array.isArray(value)) return value;
  if (Array.isArray(value?.data)) return value.data;
  return [];
}

async function forwardPending(resultPromise, type) {
  try {
    const response = await resultPromise;
    for (const request of pendingRequests(response)) {
      if (!stringValue(request?.id) || !stringValue(request?.sessionID)) continue;
      forward({
        id: `switchboard-pending-${type}-${request.id}`,
        type,
        properties: { id: request.id, sessionID: request.sessionID }
      });
    }
  } catch {
    // Endpoint availability varies across OpenCode versions.
  }
}

function recoverPendingPrompts(client, directory) {
  const tasks = [];
  try {
    if (typeof client?.permission?.list === "function") {
      tasks.push(forwardPending(client.permission.list({ directory }), "permission.asked"));
    }
    if (typeof client?.question?.list === "function") {
      tasks.push(forwardPending(client.question.list({ directory }), "question.asked"));
    }
    if (typeof client?.v2?.permission?.request?.list === "function") {
      tasks.push(
        forwardPending(
          client.v2.permission.request.list({ location: { directory } }),
          "permission.v2.asked"
        )
      );
    }
    if (typeof client?.v2?.question?.request?.list === "function") {
      tasks.push(
        forwardPending(
          client.v2.question.request.list({ location: { directory } }),
          "question.v2.asked"
        )
      );
    }
  } catch {
    return Promise.resolve();
  }
  return Promise.allSettled(tasks);
}

export const AgentSwitchboard = async ({ client, directory }) => {
  ensureTmuxForwardsNestedMarker();
  const nestedHarness = process.env[nestedHarnessEnvironment] === "1";
  if (!nestedHarness) void recoverPendingPrompts(client, directory);
  return {
    "shell.env": async (_input, output) => {
      output.env[nestedHarnessEnvironment] = "1";
    },
    event: async ({ event }) => {
      if (nestedHarness) return;
      if (!trackedEvents.has(event.type)) return;
      forward(event);
      if (promptResolvedEvents.has(event.type)) {
        void recoverPendingPrompts(client, directory);
      }
    }
  };
};
