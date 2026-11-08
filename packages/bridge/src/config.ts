// The bridge's settings, from the data attributes of the script tag the content Worker injects.
import { AnchorPath } from "@portifact/contracts";
import type { BridgeConfig } from "./bridge.ts";

const RENDERER = /^[a-z0-9][a-z0-9.@/+_-]{0,63}$/;

/** Validated settings, or null when any is missing or malformed. */
export function readConfig(data: Record<string, string | undefined>): BridgeConfig | null {
  const { appOrigin, path, renderer } = data;
  if (!appOrigin || !path) return null;
  let origin: string;
  try {
    origin = new URL(appOrigin).origin;
  } catch {
    return null;
  }
  if (origin !== appOrigin || !AnchorPath.safeParse(path).success) return null;
  if (renderer !== undefined && !RENDERER.test(renderer)) return null;
  return { appOrigin, path, ...(renderer === undefined ? {} : { renderer }) };
}
