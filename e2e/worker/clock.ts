// The content Worker's clock in the e2e Worker: real time plus an offset the control host sets for
// one artifact, so a test can move that artifact's delivery past a time window (the 60-second read
// claims) without waiting. The offset is per artifact, not global, so it never moves the clock
// under another test's handoffs and review codes, even when several workers share the stack.
// wrangler dev runs the e2e Worker in one isolate, so this module state is shared by every request.
const offsets = new Map<string, number>();

/** The artifact ID an artifact host serves: its first label. */
function artifactOf(host: string): string {
  return host.slice(0, host.indexOf("."));
}

export function contentNow(host: string): number {
  return Date.now() + (offsets.get(artifactOf(host)) ?? 0);
}

export function setContentClockOffset(artifactId: string, ms: number): void {
  if (ms === 0) offsets.delete(artifactId);
  else offsets.set(artifactId, ms);
}
