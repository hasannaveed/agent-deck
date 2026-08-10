const CSI = "\u001b[";

// The TUI draws edge-to-edge rows. Disable terminal autowrap while it owns the
// alternate screen so a character in the final column cannot create a phantom
// physical row. Restore it before returning control to the user's shell.
export const ENTER_TUI_SCREEN = `${CSI}?1049h${CSI}?7l${CSI}?25l`;
export const LEAVE_TUI_SCREEN = `${CSI}?7h${CSI}?25h${CSI}?1049l`;

export function renderTuiFrame(lines, rows) {
  const height = Math.max(1, Number.isSafeInteger(rows) ? rows : 1);
  const frame = lines.slice(0, height).map((line) => String(line ?? ""));
  while (frame.length < height) frame.push("");

  // Erase every physical line before writing it. Empty padding alone does not
  // remove characters from the previous frame, which used to leave a visual,
  // non-selectable duplicate after a session row disappeared.
  const rendered = frame.map((line) => `${CSI}2K\r${line}`).join("\r\n");
  return `${CSI}H${rendered}${CSI}J`;
}
