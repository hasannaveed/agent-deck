import { Transform } from "node:stream";
import { StringDecoder } from "node:string_decoder";

const BENIGN_CHROMIUM_DIAGNOSTICS = [
  /^\[\d+:\d+\/[\d.]+:ERROR:ui\/gl\/gl_surface_presentation_helper\.cc:\d+\] GetVSyncParametersIfAvailable\(\) failed for \d+ times!\r?\n?$/,
  /^\[\d+:\d+\/[\d.]+:ERROR:ui\/gfx\/x\/atom_cache\.cc:\d+\] Add _NET_RESTACK_WINDOW to kAtomsToCache\r?\n?$/,
];

export function isBenignChromiumDiagnostic(line) {
  // Chromium falls back to timer-based presentation after the VSync probe and
  // emits the atom-cache line as a developer reminder when Electron first uses
  // its restack atom. Keep every other stderr line visible so real Electron and
  // graphics failures remain diagnosable.
  return BENIGN_CHROMIUM_DIAGNOSTICS.some((pattern) => pattern.test(String(line)));
}

export class ChromiumStderrFilter extends Transform {
  constructor() {
    super();
    this.decoder = new StringDecoder("utf8");
    this.pending = "";
  }

  forwardCompleteLines() {
    let newline = this.pending.indexOf("\n");
    while (newline >= 0) {
      const line = this.pending.slice(0, newline + 1);
      this.pending = this.pending.slice(newline + 1);
      if (!isBenignChromiumDiagnostic(line)) this.push(line);
      newline = this.pending.indexOf("\n");
    }
  }

  _transform(chunk, _encoding, callback) {
    this.pending += this.decoder.write(chunk);
    this.forwardCompleteLines();
    callback();
  }

  _flush(callback) {
    this.pending += this.decoder.end();
    this.forwardCompleteLines();
    if (this.pending && !isBenignChromiumDiagnostic(this.pending)) this.push(this.pending);
    this.pending = "";
    callback();
  }
}
