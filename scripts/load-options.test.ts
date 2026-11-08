import { describe, expect, it } from "vitest";
import { patternChunks, percentile, splitBytes, summarize, tally } from "./load/measure.ts";
import { isProductionHost, PRODUCTION_FLAG, parseOptions, SCENARIOS } from "./load/options.ts";

const staging = ["--app-url", "https://app.staging.example", "--content-domain", "staging.dev"];

function options(argv: string[]) {
  const parsed = parseOptions(argv);
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.options;
}

function refusal(argv: string[]): string {
  const parsed = parseOptions(argv);
  if (parsed.ok) throw new Error("expected the options to be refused");
  return parsed.error;
}

describe("production guard", () => {
  it("recognizes the production domains and their subdomains only", () => {
    for (const host of [
      "portifact.com",
      "app.portifact.com",
      "abc.portifact.dev",
      "PORTIFACT.DEV.",
    ]) {
      expect(isProductionHost(host)).toBe(true);
    }
    for (const host of [
      "staging.dev",
      "portifact.com.evil.test",
      "notportifact.dev",
      "localhost",
    ]) {
      expect(isProductionHost(host)).toBe(false);
    }
  });

  it("refuses a production app or content domain without the explicit flag", () => {
    expect(
      refusal([
        "--scenario",
        "delivery",
        "--artifact",
        "abcdefghij",
        "--app-url",
        "https://app.portifact.com",
        "--content-domain",
        "staging.dev",
      ]),
    ).toMatch(/Refusing to load-test production/);
    expect(
      refusal([
        "--scenario",
        "delivery",
        "--artifact",
        "abcdefghij",
        "--app-url",
        "https://app.staging.example",
        "--content-domain",
        "portifact.dev",
      ]),
    ).toMatch(/Refusing to load-test production/);
  });

  it("allows production only with the flag", () => {
    const parsed = options([
      "--scenario",
      "delivery",
      "--artifact",
      "abcdefghij",
      "--app-url",
      "https://app.portifact.com/ignored/path",
      "--content-domain",
      "portifact.dev",
      PRODUCTION_FLAG,
    ]);
    expect(parsed.target).toEqual({
      kind: "remote",
      appOrigin: "https://app.portifact.com",
      contentDomain: "portifact.dev",
    });
  });
});

describe("parseOptions", () => {
  it("targets the local stack with every scenario and the defaults", () => {
    expect(options([])).toEqual({
      target: { kind: "local" },
      scenarios: [...SCENARIOS],
      publishers: 8,
      concurrency: 32,
      durationSeconds: 10,
      authors: 4,
      writes: 8,
      artifact: null,
      json: false,
    });
  });

  it("reads scenarios, numbers and flags", () => {
    const parsed = options([
      "--scenario",
      "delivery, delivery,annotations",
      "--concurrency",
      "4",
      "--duration",
      "2",
      "--publishers",
      "3",
      "--authors",
      "2",
      "--writes",
      "6",
      "--json",
    ]);
    expect(parsed).toMatchObject({
      scenarios: ["delivery", "annotations"],
      concurrency: 4,
      durationSeconds: 2,
      publishers: 3,
      authors: 2,
      writes: 6,
      json: true,
    });
  });

  it("refuses unknown options, scenarios, missing values and bad numbers", () => {
    expect(refusal(["--fast"])).toBe("Unknown option --fast.");
    expect(refusal(["--scenario", "soak"])).toBe("Unknown scenario soak.");
    expect(refusal(["--duration"])).toBe("--duration needs a value.");
    expect(refusal(["--duration", "--json"])).toBe("--duration needs a value.");
    for (const bad of ["0", "-1", "1.5", "many"]) {
      expect(refusal(["--concurrency", bad])).toBe("--concurrency needs a positive integer.");
    }
    expect(refusal(["--artifact", "../etc"])).toBe("--artifact must be an artifact ID.");
  });

  it("requires a complete, https remote target with explicit scenarios", () => {
    expect(refusal(["--app-url", "https://app.staging.example"])).toMatch(/both --app-url/);
    expect(refusal(["--content-domain", "staging.dev"])).toMatch(/both --app-url/);
    expect(
      refusal(["--app-url", "http://app.staging.example", "--content-domain", "staging.dev"]),
    ).toBe("--app-url must be an https URL.");
    expect(
      refusal(["--app-url", "https://app.staging.example", "--content-domain", "staging"]),
    ).toMatch(/must be a domain name/);
    expect(refusal(staging)).toMatch(/needs --scenario/);
    expect(refusal([...staging, "--scenario", "delivery,annotations"])).toBe(
      "delivery and annotations on a remote target need --artifact.",
    );
    expect(options([...staging, "--scenario", "quota-race"]).target).toEqual({
      kind: "remote",
      appOrigin: "https://app.staging.example",
      contentDomain: "staging.dev",
    });
  });
});

describe("measurements", () => {
  it("takes nearest-rank percentiles and summarizes latencies", () => {
    const values = Array.from({ length: 100 }, (_, i) => i + 1);
    expect(percentile(values, 0.5)).toBe(50);
    expect(percentile(values, 0.95)).toBe(95);
    expect(percentile(values, 0)).toBe(1);
    expect(percentile([], 0.5)).toBe(0);
    expect(summarize([3, 1.04, 2])).toEqual({
      count: 3,
      minMs: 1,
      p50Ms: 2,
      p95Ms: 3,
      p99Ms: 3,
      maxMs: 3,
    });
    expect(summarize([])).toMatchObject({ count: 0, minMs: 0, maxMs: 0 });
  });

  it("tallies values", () => {
    expect(tally([200, 200, 429, "x"])).toEqual({ "200": 2, "429": 1, x: 1 });
  });

  it("splits a byte total into near-equal parts that add up exactly", () => {
    const parts = splitBytes(250_000_000 - 43, 4);
    expect(parts.reduce((a, b) => a + b, 0)).toBe(250_000_000 - 43);
    expect(Math.max(...parts) - Math.min(...parts)).toBeLessThanOrEqual(1);
    expect(Math.max(...parts)).toBeLessThan(64 * 1024 * 1024);
    expect(splitBytes(10, 3)).toEqual([4, 3, 3]);
  });

  it("generates the same bytes for a seed in bounded chunks, and other bytes for another seed", () => {
    const collect = (seed: number, size: number, chunk: number) => {
      const chunks = [...patternChunks(seed, size, chunk)];
      return { sizes: chunks.map((c) => c.byteLength), bytes: Buffer.concat(chunks) };
    };
    const a = collect(7, 10_003, 4_096);
    expect(a.sizes).toEqual([4_096, 4_096, 1_811]);
    expect(a.bytes.equals(collect(7, 10_003, 4_096).bytes)).toBe(true);
    expect(a.bytes.equals(collect(8, 10_003, 4_096).bytes)).toBe(false);
    // The chunk size does not change the content, and a zero seed still varies.
    expect(collect(7, 10_003, 1_000).bytes.equals(a.bytes)).toBe(true);
    expect(collect(7, 10_003, 1_001).sizes[0]).toBe(1_000);
    expect(new Set(collect(0, 4_096, 4_096).bytes).size).toBeGreaterThan(200);
    expect([...patternChunks(1, 0)]).toEqual([]);
  });
});
