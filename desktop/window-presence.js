export function keepPinnedWindowVisibleAfterJump({
  window,
  shouldRestore,
  applyPin,
  schedule = setTimeout,
  settleDelayMs = 120,
}) {
  const eligible = () =>
    Boolean(window) &&
    !window.isDestroyed() &&
    (typeof shouldRestore !== "function" || shouldRestore());

  if (!eligible()) return null;

  const restore = () => {
    if (!eligible()) return;
    applyPin?.(window);
    window.showInactive();
    try {
      // moveTop changes z-order without taking keyboard focus from the terminal.
      window.moveTop();
    } catch {
      // Some Wayland compositors do not implement explicit z-order changes.
    }
  };

  restore();
  const timer = schedule(restore, settleDelayMs);
  timer?.unref?.();
  return timer;
}
