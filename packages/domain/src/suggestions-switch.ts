// The switch of edit suggestions (decision 0027, "Deliveries"): exactly `"true"` in
// `SUGGESTIONS_ENABLED` on the app and jobs Workers. Off, nothing about suggestions is reachable.
// Never set in a deployed `wrangler.jsonc` before the whole text delivery and its release checks
// are done (docs/releasing.md, "Suggestions").
import { SUGGESTIONS_SWITCH } from "@portifact/contracts";

export interface SuggestionsEnv {
  SUGGESTIONS_ENABLED?: string | undefined;
}

export function suggestionsEnabled(env: SuggestionsEnv): boolean {
  return env[SUGGESTIONS_SWITCH] === "true";
}
