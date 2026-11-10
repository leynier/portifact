import { strykerConfig } from "../../stryker.base.mjs";

export default strykerConfig({
  mutate: ["src/**/*.ts", "!src/**/*.test.ts", "!src/index.ts", "!src/testing/**"],
  // Measured score rounded down (docs/testing.md); raise it as tests improve, never lower it.
  break: 86,
});
