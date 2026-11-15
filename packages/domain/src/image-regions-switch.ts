// The switch of image regions (decision 0028): exactly `"true"` in `IMAGE_REGIONS_ENABLED` on the
// app Worker (the API accepts a region, the viewer offers one) and the content Worker (the bridge
// reports which file a picked image shows). Off, nothing about regions is reachable. Never set in
// a deployed `wrangler.jsonc` (docs/releasing.md, "Image regions").
import { IMAGE_REGIONS_SWITCH } from "@portifact/contracts";

export interface ImageRegionsEnv {
  IMAGE_REGIONS_ENABLED?: string | undefined;
}

export function imageRegionsEnabled(env: ImageRegionsEnv): boolean {
  return env[IMAGE_REGIONS_SWITCH] === "true";
}
