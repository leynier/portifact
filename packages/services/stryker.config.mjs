import { strykerConfig } from "../../stryker.base.mjs";

export default strykerConfig({
  mutate: ["src/**/*.ts", "!src/index.ts", "!src/testing/**"],
  // The first full run of the mutation workflow (2026-11-08, about 1.5 h) scored 83.08%.
  break: 83,
});
