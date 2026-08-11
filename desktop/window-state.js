import { DESKTOP_LAYOUT_VERSION } from "./window-layout.js";

function validBounds(value) {
  return (
    value &&
    ["x", "y", "width", "height"].every((key) => Number.isInteger(value[key]))
  );
}

export function defaultDesktopState() {
  return {
    layoutVersion: DESKTOP_LAYOUT_VERSION,
    pinned: true,
    collapsed: false,
    expandedBounds: null,
  };
}

export function normalizeDesktopState(value) {
  if (!value || typeof value !== "object") return defaultDesktopState();
  const expandedBounds = validBounds(value.expandedBounds)
    ? value.expandedBounds
    : validBounds(value.bounds)
      ? value.bounds
      : null;

  return {
    layoutVersion: Number.isInteger(value.layoutVersion) ? value.layoutVersion : 1,
    // Switchboard is an attention surface. Keeping it above normal windows is
    // a product invariant, not a preference that can be disabled accidentally.
    pinned: true,
    collapsed: value.collapsed === true,
    expandedBounds,
  };
}

export function rememberableExpandedBounds(window, { minWidth, minHeight }) {
  if (!window || window.isDestroyed()) return null;
  if (typeof window.isNormal === "function" && !window.isNormal()) return null;
  const bounds = window.getBounds();
  if (!validBounds(bounds) || bounds.width < minWidth || bounds.height < minHeight) return null;
  return bounds;
}
