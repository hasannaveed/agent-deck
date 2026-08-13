import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createSwitchboardServer } from "../src/server.js";
import { SwitchboardStore } from "../src/store.js";

function statusWithHost(baseUrl, host) {
  const url = new URL("/api/v1/client-token", baseUrl);
  return new Promise((resolve, reject) => {
    const request = http.get(
      { hostname: url.hostname, port: url.port, path: url.pathname, headers: { Host: host } },
      (response) => {
        response.resume();
        response.on("end", () => resolve(response.statusCode));
      },
    );
    request.on("error", reject);
  });
}

test("the local API serves the GUI and protects writes with a bearer token", async (context) => {
  const store = new SwitchboardStore(":memory:");
  const service = createSwitchboardServer({
    store,
    token: "test-token",
    host: "127.0.0.1",
    port: 0,
    logger: { error() {} },
  });
  await service.start();
  context.after(async () => {
    await service.stop();
    store.close();
  });

  const address = service.server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const health = await fetch(`${baseUrl}/api/v1/health`).then((response) => response.json());
  assert.equal(health.status, "ok");

  const page = await fetch(baseUrl);
  assert.equal(page.status, 200);
  assert.match(page.headers.get("content-security-policy"), /default-src 'self'/);
  assert.match(await page.text(), /Agent Switchboard/);

  assert.equal(await statusWithHost(baseUrl, "attacker.example"), 421);

  const body = {
    eventId: "api-start",
    harness: "opencode",
    nativeSessionId: "api-session",
    kind: "session_started",
    nativeType: "session.created",
  };
  const denied = await fetch(`${baseUrl}/api/v1/events`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  assert.equal(denied.status, 401);

  const accepted = await fetch(`${baseUrl}/api/v1/events`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer test-token" },
    body: JSON.stringify(body),
  });
  assert.equal(accepted.status, 202);
  assert.equal((await accepted.json()).accepted, 1);

  const normalized = await fetch(`${baseUrl}/api/v1/events`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer test-token" },
    body: JSON.stringify({
      ...body,
      eventId: "api-normalized",
      harness: "CODEX",
      nativeSessionId: "normalized-session",
      nativeType: `${"x".repeat(180)}\nprivate`,
      confidence: "not-a-number",
    }),
  });
  assert.equal(normalized.status, 202);
  assert.equal((await normalized.json()).accepted, 1);
  const adapterHealth = store.listAdapterHealth();
  assert.deepEqual(adapterHealth.map((adapter) => adapter.adapter).sort(), ["codex", "opencode"]);
  assert.equal(adapterHealth.find((adapter) => adapter.adapter === "codex").detail.length, 140);

  const demo = await fetch(`${baseUrl}/api/v1/events`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer test-token" },
    body: JSON.stringify({
      ...body,
      eventId: "demo-start",
      nativeSessionId: "demo-opencode-working",
      nativeType: "demo.session_started",
    }),
  });
  assert.equal(demo.status, 202);

  const deniedCleanup = await fetch(`${baseUrl}/api/v1/demo/clear`, { method: "POST", body: "{}" });
  assert.equal(deniedCleanup.status, 401);
  const cleanup = await fetch(`${baseUrl}/api/v1/demo/clear`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer test-token" },
    body: "{}",
  });
  assert.deepEqual(await cleanup.json(), { sessions: 1, events: 1, adapters: 1 });

  const snapshot = await fetch(`${baseUrl}/api/v1/sessions`).then((response) => response.json());
  assert.equal(snapshot.sessions[0].primaryState, "idle");
});

test("GUI assets are read from disk for every request", async (context) => {
  const directory = mkdtempSync(path.join(tmpdir(), "agent-switchboard-assets-"));
  const file = path.join(directory, "mutable.txt");
  writeFileSync(file, "first\n");
  const store = new SwitchboardStore(":memory:");
  const service = createSwitchboardServer({
    store,
    token: "test-token",
    host: "127.0.0.1",
    port: 0,
    assets: new Map([["/mutable.txt", { type: "text/plain; charset=utf-8", file }]]),
    logger: { error() {} },
  });
  await service.start();
  context.after(async () => {
    await service.stop();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });

  const address = service.server.address();
  const url = `http://127.0.0.1:${address.port}/mutable.txt`;
  assert.equal(await fetch(url).then((response) => response.text()), "first\n");
  writeFileSync(file, "second\n");
  assert.equal(await fetch(url).then((response) => response.text()), "second\n");
});
