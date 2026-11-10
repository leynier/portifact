import { describe, expect, it } from "vitest";
import {
  BRAND_LIMITS,
  BRAND_LOGO_PATH,
  BrandColor,
  BrandSettings,
  BrandUpdate,
  brandLogoKey,
  ViewerBrand,
} from "./branding.ts";
import { ViewerInfo } from "./review.ts";

describe("brand shapes", () => {
  it.each([
    ["#1a2b3c", "#1a2b3c"],
    ["#ABCDEF", "#abcdef"],
    ["#000000", "#000000"],
  ])("takes the color %s as %s", (input, output) => {
    expect(BrandColor.parse(input)).toBe(output);
  });

  it.each(["#fff", "#1234567", "1a2b3c", "#gggggg", "red", "rgb(0,0,0)", "#00000080", " #000000"])(
    "refuses the color %j",
    (input) => {
      expect(BrandColor.safeParse(input).success).toBe(false);
    },
  );

  it("takes an update of the four values and nothing else", () => {
    expect(BrandUpdate.parse({ name: "Acme", accentColor: "#ABCDEF", link: null })).toEqual({
      name: "Acme",
      accentColor: "#abcdef",
      link: null,
    });
    expect(
      BrandUpdate.safeParse({ name: "Acme", accentColor: null, link: null, css: "x" }).success,
    ).toBe(false);
    expect(BrandUpdate.safeParse({ name: "Acme", accentColor: null }).success).toBe(false);
    expect(
      BrandUpdate.safeParse({
        name: "Acme",
        accentColor: null,
        link: `https://a.co/${"a".repeat(BRAND_LIMITS.linkMaxLength)}`,
      }).success,
    ).toBe(false);
    expect(
      BrandUpdate.safeParse({ name: "a".repeat(401), accentColor: null, link: null }).success,
    ).toBe(false);
  });

  it("keeps the limits the product describes", () => {
    expect(BRAND_LIMITS).toEqual({
      nameMaxLength: 60,
      linkMaxLength: 2048,
      logoMaxBytes: 100_000,
      logoMaxWidth: 1024,
      logoMaxHeight: 1024,
      logoMinSide: 16,
    });
  });

  it("keeps logos outside the objects the storage reconciliation scans", () => {
    expect(brandLogoKey("u_1", "a".repeat(64))).toBe(`brands/u_1/${"a".repeat(64)}`);
    expect(BRAND_LOGO_PATH).toBe("/__portifact/brand/");
  });

  it("accepts a viewer brand only with an https logo URL and a stored color", () => {
    const brand = {
      name: "Acme",
      accentColor: "#1a2b3c",
      link: "https://acme.example.com/",
      logo: { url: "https://a1.portifact.dev/__portifact/brand/x", width: 64, height: 32 },
    };
    expect(ViewerBrand.parse(brand)).toEqual(brand);
    expect(ViewerBrand.safeParse({ ...brand, accentColor: "#ABCDEF" }).success).toBe(false);
    expect(ViewerBrand.safeParse({ ...brand, html: "<b>x</b>" }).success).toBe(false);
    const info = {
      artifactId: "abcdefghij",
      name: "Plan",
      type: "site",
      origin: "https://abcdefghij.portifact.dev",
      versionNumber: 1,
      accessMode: "public",
      annotations: "off",
      role: "anonymous",
    };
    expect(ViewerInfo.safeParse(info).success).toBe(false);
    expect(ViewerInfo.safeParse({ ...info, brand: null }).success).toBe(true);
  });

  it("describes the Branding page's state", () => {
    expect(
      BrandSettings.parse({ available: false, lowestPlan: "pro", suspended: false, brand: null }),
    ).toEqual({ available: false, lowestPlan: "pro", suspended: false, brand: null });
  });
});
