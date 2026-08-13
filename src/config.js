import { randomBytes } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { isIP } from "node:net";
import { homedir } from "node:os";
import path from "node:path";

export const APP_NAME = "Agent Switchboard";
export const APP_VERSION = "0.1.0";
export const DEFAULT_HOST = "127.0.0.1";
export const DEFAULT_PORT = 43117;
export const STATE_OWNERSHIP_MARKER = ".agent-switchboard-owned";
export const STATE_OWNERSHIP_CONTENT = "Agent Switchboard user state\n";
const MAX_TIMER_MS = 2_147_483_647;

export function resolveSwitchboardHome(env = process.env) {
  if (env.SWITCHBOARD_HOME) return path.resolve(env.SWITCHBOARD_HOME);
  if (env.XDG_STATE_HOME) return path.join(path.resolve(env.XDG_STATE_HOME), "agent-switchboard");
  return path.join(homedir(), ".local", "state", "agent-switchboard");
}

function parsePort(value) {
  return parsePositiveInteger("SWITCHBOARD_PORT", value, DEFAULT_PORT, 65535);
}

function parsePositiveInteger(name, value, fallback, maximum = Number.MAX_SAFE_INTEGER) {
  if (value === undefined || value === null || value === "") return fallback;
  const source = String(value).trim();
  const parsed = /^\d+$/.test(source) ? Number(source) : Number.NaN;
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > maximum) {
    throw new Error(`Invalid ${name}: ${value}`);
  }
  return parsed;
}

function parseHost(value) {
  const source = String(value || DEFAULT_HOST).trim();
  const bracketed = source.match(/^\[([^\]]+)\]$/);
  const host = bracketed ? bracketed[1] : source;
  if (
    !host ||
    (!isIP(host) &&
      host !== "localhost" &&
      !/^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/i.test(host))
  ) {
    throw new Error(`Invalid SWITCHBOARD_HOST: ${value}`);
  }
  return host;
}

function hostForUrl(host) {
  return isIP(host) === 6 ? `[${host}]` : host;
}

export function getRuntimeConfig(env = process.env) {
  const home = resolveSwitchboardHome(env);
  const host = parseHost(env.SWITCHBOARD_HOST);
  const port = parsePort(env.SWITCHBOARD_PORT);
  const discoveryIntervalMs = Math.max(
    750,
    parsePositiveInteger(
      "SWITCHBOARD_DISCOVERY_INTERVAL_MS",
      env.SWITCHBOARD_DISCOVERY_INTERVAL_MS,
      2500,
      MAX_TIMER_MS,
    ),
  );
  return {
    home,
    host,
    port,
    baseUrl: `http://${hostForUrl(host)}:${port}`,
    dbPath: path.join(home, "switchboard.sqlite"),
    tokenPath: path.join(home, "ingest-token"),
    ownershipPath: path.join(home, STATE_OWNERSHIP_MARKER),
    recentHours: parsePositiveInteger(
      "SWITCHBOARD_RECENT_HOURS",
      env.SWITCHBOARD_RECENT_HOURS,
      24,
      Math.floor(Number.MAX_SAFE_INTEGER / (60 * 60 * 1000)),
    ),
    maxRecent: parsePositiveInteger(
      "SWITCHBOARD_MAX_RECENT",
      env.SWITCHBOARD_MAX_RECENT,
      20,
      1_000_000,
    ),
    discoveryIntervalMs,
    activityIdleMs: Math.max(
      discoveryIntervalMs * 2,
      parsePositiveInteger(
        "SWITCHBOARD_ACTIVITY_IDLE_MS",
        env.SWITCHBOARD_ACTIVITY_IDLE_MS,
        7500,
        Number.MAX_SAFE_INTEGER,
      ),
    ),
  };
}

function isInside(directory, target) {
  const relative = path.relative(directory, target);
  return relative && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function assertRegularRuntimeFile(target, label) {
  if (!existsSync(target)) return;
  const metadata = lstatSync(target);
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    throw new Error(`${label} must be a regular file: ${target}`);
  }
}

function validateRuntimePaths(config) {
  const home = path.resolve(config.home);
  const root = path.parse(home).root;
  if (home === root || home === path.resolve(homedir())) {
    throw new Error(`Unsafe SWITCHBOARD_HOME: ${home}`);
  }
  if (existsSync(home)) {
    const metadata = lstatSync(home);
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
      throw new Error(`Switchboard state home must be a regular directory: ${home}`);
    }
  }
  for (const [label, target] of [
    ["Ownership marker", config.ownershipPath],
    ["Ingest token", config.tokenPath],
    ["State database", config.dbPath],
  ]) {
    if (!isInside(home, path.resolve(target))) {
      throw new Error(`${label} must stay inside Switchboard state home`);
    }
    assertRegularRuntimeFile(target, label);
  }
}

export function ensureRuntimeHome(config) {
  validateRuntimePaths(config);
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
  } else if (readFileSync(config.ownershipPath, "utf8") !== STATE_OWNERSHIP_CONTENT) {
    throw new Error(`Unrecognized Switchboard ownership marker: ${config.ownershipPath}`);
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
  const token = readIngestToken(config);
  if (!/^[a-f0-9]{64}$/.test(token)) {
    throw new Error(`Invalid Switchboard ingest token: ${config.tokenPath}`);
  }
  try {
    chmodSync(config.tokenPath, 0o600);
  } catch {
    // Best effort on non-POSIX filesystems.
  }
  return token;
}

export function readIngestToken(config) {
  return readFileSync(config.tokenPath, "utf8").trim();
}
