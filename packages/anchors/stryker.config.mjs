import { strykerConfig } from "../../stryker.base.mjs";

export default strykerConfig({
  mutate: ["src/**/*.ts", "!src/**/*.test.ts", "!src/test-helpers.ts", "!src/index.ts"],
  // Measured score rounded down (docs/testing.md); raise it as tests improve, never lower it.
  break: 86,
});
