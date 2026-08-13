import assert from "node:assert/strict";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  ensureRuntimeHome,
  getRuntimeConfig,
  STATE_OWNERSHIP_CONTENT,
} from "../src/config.js";

function config(overrides = {}) {
  return getRuntimeConfig({
    SWITCHBOARD_HOME: "/tmp/agent-switchboard-config-test",
    ...overrides,
  });
}

test("runtime configuration rejects malformed ports instead of partially parsing them", () => {
  for (const value of ["43117junk", "1e3", "0", "65536", "-1"]) {
    assert.throws(() => config({ SWITCHBOARD_PORT: value }), /Invalid SWITCHBOARD_PORT/);
  }
  assert.equal(config({ SWITCHBOARD_PORT: " 43117 " }).port, 43117);
});

test("runtime configuration rejects malformed or overflowing timing values", () => {
  for (const [name, value] of [
    ["SWITCHBOARD_DISCOVERY_INTERVAL_MS", "2500ms"],
    ["SWITCHBOARD_DISCOVERY_INTERVAL_MS", "2147483648"],
    ["SWITCHBOARD_ACTIVITY_IDLE_MS", "1e9"],
    ["SWITCHBOARD_RECENT_HOURS", "forever"],
    ["SWITCHBOARD_MAX_RECENT", "1000001"],
  ]) {
    assert.throws(() => config({ [name]: value }), new RegExp(`Invalid ${name}`));
  }
  const clamped = config({
    SWITCHBOARD_DISCOVERY_INTERVAL_MS: "100",
    SWITCHBOARD_ACTIVITY_IDLE_MS: "200",
  });
  assert.equal(clamped.discoveryIntervalMs, 750);
  assert.equal(clamped.activityIdleMs, 1500);
});

test("runtime configuration formats IPv4, hostnames, and IPv6 safely", () => {
  assert.equal(config().baseUrl, "http://127.0.0.1:43117");
  assert.equal(config({ SWITCHBOARD_HOST: "localhost" }).baseUrl, "http://localhost:43117");
  assert.deepEqual(
    {
      host: config({ SWITCHBOARD_HOST: "[::1]" }).host,
      baseUrl: config({ SWITCHBOARD_HOST: "[::1]" }).baseUrl,
    },
    { host: "::1", baseUrl: "http://[::1]:43117" },
  );
  assert.throws(
    () => config({ SWITCHBOARD_HOST: "127.0.0.1/path" }),
    /Invalid SWITCHBOARD_HOST/,
  );
});

test("runtime state refuses broad homes and linked sensitive files before writing", () => {
  assert.throws(
    () =>
      ensureRuntimeHome({
        home: "/",
        ownershipPath: "/.agent-switchboard-owned",
        tokenPath: "/ingest-token",
        dbPath: "/switchboard.sqlite",
      }),
    /Unsafe SWITCHBOARD_HOME/,
  );

  const directory = mkdtempSync(path.join(tmpdir(), "agent-switchboard-config-safe-"));
  const external = path.join(directory, "external-token");
  const home = path.join(directory, "state");
  const runtime = getRuntimeConfig({ SWITCHBOARD_HOME: home });
  try {
    writeFileSync(external, "do-not-touch\n");
    writeFileSync(path.join(directory, "placeholder"), "placeholder\n");
    ensureRuntimeHome(runtime);
    assert.match(readFileSync(runtime.tokenPath, "utf8"), /^[a-f0-9]{64}\n$/);

    rmSync(runtime.tokenPath);
    symlinkSync(external, runtime.tokenPath);
    assert.throws(() => ensureRuntimeHome(runtime), /Ingest token must be a regular file/);
    assert.equal(readFileSync(external, "utf8"), "do-not-touch\n");

    rmSync(runtime.tokenPath);
    writeFileSync(runtime.tokenPath, `${"a".repeat(64)}\n`, { mode: 0o600 });
    writeFileSync(runtime.ownershipPath, "foreign marker\n");
    assert.throws(() => ensureRuntimeHome(runtime), /Unrecognized Switchboard ownership marker/);
    writeFileSync(runtime.ownershipPath, STATE_OWNERSHIP_CONTENT);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
