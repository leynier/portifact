// The content Worker's clock in the e2e Worker: real time plus an offset the control host sets,
// so a test can move delivery past a time window (the 60-second read claims) without waiting.
// wrangler dev runs the e2e Worker in one isolate, so this module state is shared by every request.
let offsetMs = 0;

export function contentNow(): number {
  return Date.now() + offsetMs;
}

export function setContentClockOffset(ms: number): void {
  offsetMs = ms;
}
