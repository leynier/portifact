// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { axeViolations } from "./axe.ts";

describe("axeViolations", () => {
  it("reports real violations in happy-dom, so a passing check means something", async () => {
    document.body.innerHTML = '<main><button type="button"></button><img src="x.png"></main>';
    const ids = (await axeViolations(document.body)).map((violation) => violation.id);
    expect(ids).toContain("button-name");
    expect(ids).toContain("image-alt");
  });

  it("returns nothing for accessible markup", async () => {
    document.body.innerHTML = '<main><button type="button">Save</button></main>';
    expect(await axeViolations(document.body)).toEqual([]);
  });
});
