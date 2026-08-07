// Agent Switchboard OpenCode integration.
import { spawn } from "node:child_process";

// The installer replaces these two declarations with absolute paths. Keeping
// command-name defaults makes the template usable after `npm link` as well.
const bridgeCommand = "switchboardctl";
const bridgeArguments = ["emit", "--harness", "opencode", "--stream"];
const nestedHarnessEnvironment = "AGENT_SWITCHBOARD_CHILD";
const maximumQueuedEvents = 256;

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

const promptAskedEvents = new Set([
  "permission.asked",
  "permission.updated",
  "permission.v2.asked",
  "question.asked",
  "question.v2.asked"
]);

function stringValue(value) {
  return typeof value === "string" && value ? value : undefined;
}

// Only lifecycle metadata crosses the plugin boundary. In particular, command
// text, permission patterns, question text, answers, and model output are never
// included in the object sent to Switchboard.
function lifecycleEvent(event) {
  if (!event || typeof event.type !== "string") return null;
  const properties = {
    ...(event.data && typeof event.data === "object" ? event.data : {}),
    ...(event.properties && typeof event.properties === "object" ? event.properties : {})
  };
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
    requestID:
      stringValue(properties.requestID) ||
      stringValue(properties.requestId) ||
      stringValue(properties.permissionID),
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

function promptEvent(type) {
  return type.startsWith("permission.") || type.startsWith("question.");
}

function noisyEventKey(event) {
  if (!["session.updated", "session.status"].includes(event.type)) return null;
  return `${event.type}:${event.properties?.sessionID || ""}`;
}

function createBridgeForwarder() {
  let bridge = null;
  let disposed = false;
  let waitingForDrain = false;
  let restartTimer = null;
  const queue = [];
  const replayable = [];

  const debug = (message) => {
    if (process.env.SWITCHBOARD_DEBUG) console.error(`[switchboard plugin] ${message}`);
  };

  const scheduleRestart = () => {
    if (disposed || restartTimer || !queue.length) return;
    restartTimer = setTimeout(() => {
      restartTimer = null;
      pump();
    }, 100);
    restartTimer.unref?.();
  };

  const bridgeClosed = (instance, error) => {
    if (bridge !== instance) return;
    bridge = null;
    waitingForDrain = false;
    if (error) debug(error.message || String(error));
    if (!disposed && replayable.length) {
      const queuedLines = new Set(queue.map((item) => item.line));
      for (let index = replayable.length - 1; index >= 0; index -= 1) {
        const item = replayable[index];
        if (!queuedLines.has(item.line)) queue.unshift(item);
      }
    }
    scheduleRestart();
  };

  const ensureBridge = () => {
    if (bridge || disposed) return bridge;
    try {
      const child = spawn(bridgeCommand, bridgeArguments, {
        detached: false,
        stdio: ["pipe", "ignore", process.env.SWITCHBOARD_DEBUG ? "inherit" : "ignore"],
        windowsHide: true
      });
      bridge = child;
      child.on("error", (error) => bridgeClosed(child, error));
      child.on("exit", (code) => {
        if (code && !disposed) debug(`bridge exited with status ${code}`);
        bridgeClosed(child);
      });
      child.stdin.on("error", (error) => bridgeClosed(child, error));
      child.unref();
      return child;
    } catch (error) {
      debug(error.message || String(error));
      scheduleRestart();
      return null;
    }
  };

  function pump() {
    if (disposed || waitingForDrain || !queue.length) return;
    const child = ensureBridge();
    if (!child) return;
    while (bridge === child && queue.length) {
      const item = queue[0];
      let accepted;
      try {
        accepted = child.stdin.write(`${item.line}\n`);
      } catch (error) {
        bridgeClosed(child, error);
        return;
      }
      queue.shift();
      if (item.critical) {
        replayable.push(item);
        if (replayable.length > 64) replayable.shift();
      }
      if (!accepted) {
        waitingForDrain = true;
        child.stdin.once("drain", () => {
          if (bridge !== child) return;
          waitingForDrain = false;
          pump();
        });
        return;
      }
    }
  }

  const forward = (event) => {
    const safeEvent = lifecycleEvent(event);
    if (!safeEvent || disposed) return;
    const item = {
      line: JSON.stringify(safeEvent),
      critical: promptEvent(safeEvent.type)
    };
    const noisyKey = noisyEventKey(safeEvent);
    if (noisyKey) {
      const existing = queue.findIndex((candidate) => candidate.noisyKey === noisyKey);
      if (existing >= 0) {
        queue[existing] = { ...item, noisyKey };
        pump();
        return;
      }
      item.noisyKey = noisyKey;
    }
    if (queue.length >= maximumQueuedEvents) {
      const replaceable = queue.findIndex((candidate) => !candidate.critical);
      if (replaceable >= 0) queue.splice(replaceable, 1);
      else queue.shift();
    }
    queue.push(item);
    pump();
  };

  const dispose = () => {
    disposed = true;
    if (restartTimer) clearTimeout(restartTimer);
    restartTimer = null;
    queue.length = 0;
    replayable.length = 0;
    const child = bridge;
    bridge = null;
    if (!child) return;
    try {
      child.stdin.destroy();
      child.kill();
    } catch {
      // OpenCode must remain usable if the bridge already exited.
    }
  };

  return { forward, dispose };
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

function pendingRequest(request, kind) {
  const id =
    stringValue(request?.id) ||
    stringValue(request?.requestID) ||
    stringValue(request?.requestId) ||
    stringValue(request?.permissionID);
  const sessionID =
    stringValue(request?.sessionID) ||
    stringValue(request?.sessionId) ||
    stringValue(request?.session?.id);
  if (!id || !sessionID) return null;
  return { id, sessionID, kind };
}

async function collectPendingPrompts(client, directory) {
  const endpoints = new Map([
    ["permission", []],
    ["question", []]
  ]);
  const add = (kind, invoke) => {
    endpoints.get(kind).push(invoke);
  };

  if (typeof client?.permission?.list === "function") {
    add("permission", () => client.permission.list({ directory }));
  }
  if (typeof client?.question?.list === "function") {
    add("question", () => client.question.list({ directory }));
  }
  if (typeof client?.v2?.permission?.request?.list === "function") {
    add("permission", () => client.v2.permission.request.list({ location: { directory } }));
  }
  if (typeof client?.v2?.question?.request?.list === "function") {
    add("question", () => client.v2.question.request.list({ location: { directory } }));
  }

  const results = await Promise.all(
    [...endpoints].map(async ([kind, candidates]) => {
      for (const invoke of candidates) {
        try {
          return { kind, response: await invoke() };
        } catch {
          // Try the API shape used by another supported OpenCode version.
        }
      }
      return null;
    })
  );
  const pending = new Map();
  const successfulKinds = new Set();
  for (const result of results) {
    if (!result) continue;
    successfulKinds.add(result.kind);
    for (const value of pendingRequests(result.response)) {
      const request = pendingRequest(value, result.kind);
      if (!request) continue;
      pending.set(`${request.kind}:${request.sessionID}:${request.id}`, request);
    }
  }
  return successfulKinds.size ? { pending, successfulKinds } : null;
}

function samePendingPrompts(left, right) {
  if (left.size !== right.size) return false;
  for (const key of left.keys()) if (!right.has(key)) return false;
  return true;
}

function createPromptReconciler(client, directory, forward) {
  let known = new Map();
  let generation = 0;
  let running = null;
  let rerun = false;
  let disposed = false;

  const reconcile = () => {
    if (disposed) return Promise.resolve();
    if (running) {
      rerun = true;
      return running;
    }
    running = (async () => {
      const result = await collectPendingPrompts(client, directory);
      if (disposed || result === null) return;
      const current = new Map(
        [...known].filter(([, request]) => !result.successfulKinds.has(request.kind))
      );
      for (const [key, request] of result.pending) current.set(key, request);
      if (samePendingPrompts(known, current)) return;
      generation += 1;
      const previous = known;
      known = current;

      // Resolve disappeared requests first, then re-assert every request that
      // remains. This preserves NEEDS YOU when one of several prompts closes.
      for (const [key, request] of previous) {
        if (current.has(key)) continue;
        forward({
          id: `switchboard-reconciled-resolved-${generation}-${key}`,
          type: `${request.kind}.replied`,
          properties: { requestID: request.id, sessionID: request.sessionID }
        });
      }
      for (const [key, request] of current) {
        forward({
          id: `switchboard-reconciled-asked-${generation}-${key}`,
          type: `${request.kind}.asked`,
          properties: { id: request.id, sessionID: request.sessionID }
        });
      }
    })().finally(() => {
      running = null;
      if (rerun && !disposed) {
        rerun = false;
        queueMicrotask(reconcile);
      }
    });
    return running;
  };

  const dispose = () => {
    disposed = true;
    known.clear();
  };

  return { reconcile, dispose };
}

export const AgentSwitchboard = async ({ client, directory }) => {
  ensureTmuxForwardsNestedMarker();
  const nestedHarness = process.env[nestedHarnessEnvironment] === "1";
  const bridge = nestedHarness ? null : createBridgeForwarder();
  const prompts = nestedHarness
    ? null
    : createPromptReconciler(client, directory, bridge.forward);
  let promptPoll = null;
  if (prompts) {
    void prompts.reconcile();
    promptPoll = setInterval(() => void prompts.reconcile(), 1000);
    promptPoll.unref?.();
  }

  return {
    "shell.env": async (_input, output) => {
      output.env[nestedHarnessEnvironment] = "1";
    },
    event: async ({ event }) => {
      if (nestedHarness) return;
      if (!trackedEvents.has(event.type)) return;
      bridge.forward(event);
      if (promptAskedEvents.has(event.type) || promptResolvedEvents.has(event.type)) {
        void prompts.reconcile();
      }
    },
    dispose: async () => {
      if (promptPoll) clearInterval(promptPoll);
      promptPoll = null;
      prompts?.dispose();
      bridge?.dispose();
    }
  };
};
