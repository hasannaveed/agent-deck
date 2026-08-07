import { EVENT_KINDS } from "./domain.js";

const MIN_DISCOVERY_CAPTURE_WINDOW_MS = 5_000;
const CLOCK_SKEW_ALLOWANCE_MS = 1_000;

export function gnomeTerminalTargetFrom(terminal) {
  if (terminal?.terminalKind === "gnome-terminal") {
    return {
      terminalKind: "gnome-terminal",
      terminalTarget: terminal.terminalTarget,
      terminalInstance: terminal.terminalInstance,
    };
  }
  if (terminal?.hostTerminalKind === "gnome-terminal") {
    return {
      terminalKind: "gnome-terminal",
      terminalTarget: terminal.hostTerminalTarget,
      terminalInstance: terminal.hostTerminalInstance,
    };
  }
  return null;
}

export function isAutoLinkHookEvent(events) {
  return (
    Array.isArray(events) &&
    events.some(
      (event) => event?.kind === EVENT_KINDS.SESSION_STARTED || event?.humanInitiated === true,
    )
  );
}

export function shouldAutoLinkDiscoveredTerminal(
  terminal,
  occurredAt = Date.now(),
  discoveryIntervalMs = 2_500,
) {
  if (!gnomeTerminalTargetFrom(terminal)) return false;
  if (!Number.isFinite(terminal.startedAt) || !Number.isFinite(occurredAt)) return false;

  const ageMs = occurredAt - terminal.startedAt;
  const captureWindowMs = Math.max(
    MIN_DISCOVERY_CAPTURE_WINDOW_MS,
    Math.max(0, Number(discoveryIntervalMs) || 0) * 2,
  );
  return ageMs >= -CLOCK_SKEW_ALLOWANCE_MS && ageMs <= captureWindowMs;
}

export function shouldAutoLinkHookTerminal(terminal, events) {
  return Boolean(gnomeTerminalTargetFrom(terminal)) && isAutoLinkHookEvent(events);
}
