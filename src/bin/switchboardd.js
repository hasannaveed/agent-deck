#!/usr/bin/env node

import { getRuntimeConfig } from "../config.js";
import { startSwitchboardRuntime } from "../runtime.js";

function hasFlag(flag) {
  return process.argv.slice(2).includes(flag);
}

async function main() {
  const config = getRuntimeConfig();
  const runtime = await startSwitchboardRuntime({
    config,
    discovery: process.platform === "linux" && !hasFlag("--no-discovery"),
  });

  const shutdown = async (signal) => {
    process.stdout.write(`\nReceived ${signal}; stopping Switchboard.\n`);
    await runtime.stop();
  };

  process.once("SIGINT", () => shutdown("SIGINT").then(() => process.exit(0)));
  process.once("SIGTERM", () => shutdown("SIGTERM").then(() => process.exit(0)));

  process.stdout.write(`Agent Switchboard is running at ${config.baseUrl}\n`);
  process.stdout.write(`State: ${config.dbPath}\n`);
}

main().catch((error) => {
  if (error.code === "EADDRINUSE") {
    process.stderr.write("Switchboard is already running, or its port is in use.\n");
  } else {
    process.stderr.write(`${error.stack || error.message}\n`);
  }
  process.exitCode = 1;
});
