export const DESKTOP_LAYOUT_VERSION = 3;
export const DESKTOP_EDGE_GAP = 16;
export const EXPANDED_DEFAULT_WIDTH = 430;
export const EXPANDED_DEFAULT_HEIGHT = 820;
export const EXPANDED_MIN_WIDTH = 360;
export const EXPANDED_MIN_HEIGHT = 500;
export const COLLAPSED_WIDTH = 168;
export const COLLAPSED_HEIGHT = 52;

function finiteInteger(value, fallback) {
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

export function bottomRightBounds(workArea, size, gap = DESKTOP_EDGE_GAP) {
  const width = finiteInteger(size?.width, EXPANDED_DEFAULT_WIDTH);
  const height = finiteInteger(size?.height, EXPANDED_DEFAULT_HEIGHT);
  return {
    x: workArea.x + workArea.width - width - gap,
    y: workArea.y + workArea.height - height - gap,
    width,
    height,
  };
}

export function expandedBoundsAtBottomRight(workArea, previous = null) {
  const maximumWidth = Math.max(EXPANDED_MIN_WIDTH, workArea.width - DESKTOP_EDGE_GAP * 2);
  const maximumHeight = Math.max(EXPANDED_MIN_HEIGHT, workArea.height - DESKTOP_EDGE_GAP * 2);
  const width = Math.min(
    maximumWidth,
    Math.max(EXPANDED_MIN_WIDTH, finiteInteger(previous?.width, EXPANDED_DEFAULT_WIDTH)),
  );
  const height = Math.min(
    maximumHeight,
    Math.max(
      EXPANDED_MIN_HEIGHT,
      finiteInteger(previous?.height, Math.min(EXPANDED_DEFAULT_HEIGHT, maximumHeight)),
    ),
  );
  return bottomRightBounds(workArea, { width, height });
}

export function collapsedBoundsAtBottomRight(workArea) {
  return bottomRightBounds(workArea, {
    width: COLLAPSED_WIDTH,
    height: COLLAPSED_HEIGHT,
  });
}
