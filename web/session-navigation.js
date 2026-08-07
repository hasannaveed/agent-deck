export function sessionNavigationCommand(key, currentIndex, sessionCount) {
  if (!Number.isInteger(sessionCount) || sessionCount <= 0) return null;

  const down = key === "ArrowDown" || key === "j";
  const up = key === "ArrowUp" || key === "k";
  if (down || up) {
    const direction = down ? 1 : -1;
    const hasCurrent = Number.isInteger(currentIndex) && currentIndex >= 0 && currentIndex < sessionCount;
    const index = hasCurrent
      ? (currentIndex + direction + sessionCount) % sessionCount
      : direction > 0
        ? 0
        : sessionCount - 1;
    return { action: "select", index };
  }

  if (key === "Enter" && Number.isInteger(currentIndex) && currentIndex >= 0 && currentIndex < sessionCount) {
    return { action: "activate", index: currentIndex };
  }
  return null;
}
