import { REGIONS } from "@portifact/contracts";
import { describe, expect, it } from "vitest";
import { noticeDetail, noticeNames } from "./notices.ts";

describe("noticeDetail", () => {
  it("lets notices about the default region name artifacts", () => {
    expect(noticeDetail("default")).toBe("named");
    expect(noticeNames("default")).toBe(true);
  });

  it("keeps notices about the EU to counts and links", () => {
    expect(noticeDetail("eu")).toBe("counts");
    expect(noticeNames("eu")).toBe(false);
  });

  it("names artifacts in no region besides the default one", () => {
    const named = REGIONS.filter((region) => noticeNames(region));
    expect(named).toEqual(["default"]);
  });
});
