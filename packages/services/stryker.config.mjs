import { strykerConfig } from "../../stryker.base.mjs";

export default strykerConfig({
  mutate: ["src/**/*.ts", "!src/index.ts"],
  // No break threshold yet: the full run takes over an hour, and only a partial local run was
  // measured. The weekly mutation workflow establishes the score; set it from that, rounded down.
  break: null,
});
