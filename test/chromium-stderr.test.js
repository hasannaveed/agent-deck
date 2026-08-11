import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";
import {
  ChromiumStderrFilter,
  isBenignChromiumDiagnostic,
} from "../desktop/chromium-stderr.js";

const VSYNC_LINE =
  "[118960:0811/095115.929651:ERROR:ui/gl/gl_surface_presentation_helper.cc:260] GetVSyncParametersIfAvailable() failed for 1 times!\n";
const RESTACK_LINE =
  "[123518:0811/100302.269614:ERROR:ui/gfx/x/atom_cache.cc:234] Add _NET_RESTACK_WINDOW to kAtomsToCache\n";

test("only Chromium's known presentation and restack diagnostics are hidden", async () => {
  assert.equal(isBenignChromiumDiagnostic(VSYNC_LINE), true);
  assert.equal(isBenignChromiumDiagnostic(RESTACK_LINE), true);
  assert.equal(isBenignChromiumDiagnostic("A real Electron error\n"), false);

  const filter = new ChromiumStderrFilter();
  let output = "";
  filter.setEncoding("utf8");
  filter.on("data", (chunk) => {
    output += chunk;
  });

  filter.write(VSYNC_LINE.slice(0, 47));
  filter.write(`${VSYNC_LINE.slice(47)}${RESTACK_LINE}A real Electron error\n`);
  filter.end("A final error without a newline");
  await once(filter, "end");

  assert.equal(output, "A real Electron error\nA final error without a newline");
});
