import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { SwitchboardClient } from "../src/client.js";

test("a long-running client discovers a newly created or rotated write token", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "agent-switchboard-client-"));
  const tokenPath = path.join(directory, "ingest-token");
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    calls.push({ url, options });
    return new Response(JSON.stringify({ session: { id: "codex:test" } }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };

  try {
    const client = new SwitchboardClient({
      baseUrl: "http://127.0.0.1:43117",
      tokenPath,
    });
    assert.equal(client.token, null);
    assert.throws(() => client.action("codex:test", "seen"), /start switchboardd first/);

    writeFileSync(tokenPath, "first-token\n", { mode: 0o600 });
    await client.action("codex:test", "seen");
    assert.equal(calls.at(-1).options.headers.Authorization, "Bearer first-token");

    writeFileSync(tokenPath, "rotated-token\n", { mode: 0o600 });
    await client.action("codex:test", "unread");
    assert.equal(calls.at(-1).options.headers.Authorization, "Bearer rotated-token");
  } finally {
    globalThis.fetch = originalFetch;
    rmSync(directory, { recursive: true, force: true });
  }
});
