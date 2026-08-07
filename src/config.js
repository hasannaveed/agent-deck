import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

export const APP_NAME = "Agent Switchboard";
export const APP_VERSION = "0.1.0";
export const DEFAULT_HOST = "127.0.0.1";
export const DEFAULT_PORT = 43117;
export const STATE_OWNERSHIP_MARKER = ".agent-switchboard-owned";
export const STATE_OWNERSHIP_CONTENT = "Agent Switchboard user state\n";

export function resolveSwitchboardHome(env = process.env) {
  if (env.SWITCHBOARD_HOME) return path.resolve(env.SWITCHBOARD_HOME);
  if (env.XDG_STATE_HOME) return path.join(path.resolve(env.XDG_STATE_HOME), "agent-switchboard");
  return path.join(homedir(), ".local", "state", "agent-switchboard");
}

function parsePort(value) {
  const port = Number.parseInt(String(value ?? DEFAULT_PORT), 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid SWITCHBOARD_PORT: ${value}`);
  }
  return port;
}

export function getRuntimeConfig(env = process.env) {
  const home = resolveSwitchboardHome(env);
  const host = env.SWITCHBOARD_HOST || DEFAULT_HOST;
  const port = parsePort(env.SWITCHBOARD_PORT);
  const discoveryIntervalMs = Math.max(
    750,
    Number.parseInt(env.SWITCHBOARD_DISCOVERY_INTERVAL_MS || "2500", 10) || 2500,
  );
  return {
    home,
    host,
    port,
    baseUrl: `http://${host}:${port}`,
    dbPath: path.join(home, "switchboard.sqlite"),
    tokenPath: path.join(home, "ingest-token"),
    ownershipPath: path.join(home, STATE_OWNERSHIP_MARKER),
    recentHours: Math.max(1, Number.parseInt(env.SWITCHBOARD_RECENT_HOURS || "24", 10) || 24),
    maxRecent: Math.max(1, Number.parseInt(env.SWITCHBOARD_MAX_RECENT || "20", 10) || 20),
    discoveryIntervalMs,
    activityIdleMs: Math.max(
      discoveryIntervalMs * 2,
      Number.parseInt(env.SWITCHBOARD_ACTIVITY_IDLE_MS || "7500", 10) || 7500,
    ),
  };
}

export function ensureRuntimeHome(config) {
  mkdirSync(config.home, { recursive: true, mode: 0o700 });
  try {
    chmodSync(config.home, 0o700);
  } catch {
    // Some filesystems do not expose POSIX permissions.
  }

  if (!existsSync(config.ownershipPath)) {
    writeFileSync(config.ownershipPath, STATE_OWNERSHIP_CONTENT, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
  }
  try {
    chmodSync(config.ownershipPath, 0o600);
  } catch {
    // Best effort on non-POSIX filesystems.
  }

  if (!existsSync(config.tokenPath)) {
    writeFileSync(config.tokenPath, `${randomBytes(32).toString("hex")}\n`, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
  }
  try {
    chmodSync(config.tokenPath, 0o600);
  } catch {
    // Best effort on non-POSIX filesystems.
  }
  return readIngestToken(config);
}

export function readIngestToken(config) {
  return readFileSync(config.tokenPath, "utf8").trim();
}
