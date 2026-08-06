import { ensureRuntimeHome, getRuntimeConfig } from "./config.js";
import { LinuxProcessDiscovery } from "./discovery/linux.js";
import { createSwitchboardServer } from "./server.js";
import { SwitchboardStore } from "./store.js";

export async function startSwitchboardRuntime({
  config = getRuntimeConfig(),
  discovery = process.platform === "linux",
  logger = console,
} = {}) {
  const token = ensureRuntimeHome(config);
  const store = new SwitchboardStore(config.dbPath);
  for (const adapter of ["codex", "claude", "opencode"]) {
    store.setAdapterHealth(adapter, {
      status: "waiting",
      detail: "Waiting for the first native event",
    });
  }

  const processDiscovery = discovery
    ? new LinuxProcessDiscovery({
        store,
        intervalMs: config.discoveryIntervalMs,
        activityIdleMs: config.activityIdleMs,
        logger,
      })
    : null;
  const service = createSwitchboardServer({
    store,
    token,
    host: config.host,
    port: config.port,
    recentHours: config.recentHours,
    maxRecent: config.maxRecent,
    logger,
  });

  try {
    await service.start();
  } catch (error) {
    store.close();
    throw error;
  }
  processDiscovery?.start();

  let stopped = false;
  return {
    config,
    token,
    store,
    service,
    discovery: processDiscovery,
    async stop() {
      if (stopped) return;
      stopped = true;
      processDiscovery?.stop();
      try {
        await service.stop();
      } finally {
        store.close();
      }
    },
  };
}
