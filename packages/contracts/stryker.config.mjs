import { strykerConfig } from "../../stryker.base.mjs";

export default strykerConfig({
  mutate: ["src/**/*.ts", "!src/**/*.test.ts"],
  // Measured score rounded down (docs/testing.md); raise it as tests improve, never lower it.
  break: 78,
});
