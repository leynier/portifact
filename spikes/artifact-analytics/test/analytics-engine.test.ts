// Evidence for the rejected option, not part of the design: what workerd does with a Workers
// Analytics Engine binding when nothing remote is configured.
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

describe("Workers Analytics Engine in workerd", () => {
  it("accepts writeDataPoint without awaiting, and offers no way to read the data back", () => {
    const result = env.VIEWS_AE.writeDataPoint({
      indexes: ["abcdefghij"],
      blobs: ["page"],
      doubles: [1],
    });
    expect(result).toBeUndefined();
    // The binding is write only. Reading is the SQL API on api.cloudflare.com, which a local test
    // cannot reach, so the read path (sampling, `_sample_interval`) can only be tested with a fake.
    const methods = Object.getOwnPropertyNames(Object.getPrototypeOf(env.VIEWS_AE)).filter(
      (name) => name !== "constructor",
    );
    expect(methods).toEqual(["writeDataPoint"]);
  });
});
