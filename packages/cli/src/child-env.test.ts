import { describe, expect, it } from "vitest";
import { childEnvironment, SERVICE_TOKEN_ENV } from "./child-env.ts";

describe("childEnvironment", () => {
  it("withholds the service token and keeps everything else", () => {
    const env = { PATH: "/usr/bin", [SERVICE_TOKEN_ENV]: "pfst_secret", HOME: undefined };
    expect(childEnvironment(env)).toEqual({ PATH: "/usr/bin", HOME: undefined });
    expect(env[SERVICE_TOKEN_ENV]).toBe("pfst_secret");
  });

  it("changes nothing when no token is set", () => {
    expect(childEnvironment({ PATH: "/usr/bin" })).toEqual({ PATH: "/usr/bin" });
  });
});
