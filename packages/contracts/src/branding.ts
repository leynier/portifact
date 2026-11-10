// The owner's brand on the viewer's bar (premium plan P9, feature `branding`): four validated
// values and nothing else. Never HTML, CSS or scripts: a name rendered as text, one sRGB color the
// design system derives its tokens from, an `https` link and an uploaded raster logo checked by
// its bytes. The rules are in packages/domain/src/branding.ts.
import { z } from "zod";
import { PlanName } from "./plans.ts";

export const BRAND_LIMITS = {
  /** Code points of the name, after normalization. */
  nameMaxLength: 60,
  linkMaxLength: 2048,
  /** Decimal bytes of the logo file. */
  logoMaxBytes: 100_000,
  logoMaxWidth: 1024,
  logoMaxHeight: 1024,
  /** Neither side may be smaller, so a logo is never a tracking pixel. */
  logoMinSide: 16,
} as const;

/** The raster formats a logo may have. No SVG: it can carry scripts and external references. */
export const BRAND_LOGO_TYPES = ["image/png", "image/jpeg", "image/webp"] as const;
export const BrandLogoType = z.enum(BRAND_LOGO_TYPES);
export type BrandLogoType = z.infer<typeof BrandLogoType>;

/** One sRGB color as `#rrggbb`, stored and returned in lowercase. */
export const BrandColor = z
  .string()
  .regex(/^#[0-9a-fA-F]{6}$/, "Use a color like #1a2b3c.")
  .transform((value) => value.toLowerCase());
export type BrandColor = z.infer<typeof BrandColor>;

const Sha256 = z.string().regex(/^[0-9a-f]{64}$/);

/** What the owner sets besides the logo. The domain normalizes and checks the name and link. */
export const BrandUpdate = z.strictObject({
  name: z.string().max(400),
  accentColor: BrandColor.nullable(),
  link: z.string().max(BRAND_LIMITS.linkMaxLength).nullable(),
});
export type BrandUpdate = z.infer<typeof BrandUpdate>;

export const BrandLogo = z.strictObject({
  sha256: Sha256,
  type: BrandLogoType,
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  bytes: z.number().int().positive(),
});
export type BrandLogo = z.infer<typeof BrandLogo>;

export const Brand = z.strictObject({
  name: z.string(),
  accentColor: z
    .string()
    .regex(/^#[0-9a-f]{6}$/)
    .nullable(),
  link: z.url().nullable(),
  logo: BrandLogo.nullable(),
  updatedAt: z.iso.datetime(),
});
export type Brand = z.infer<typeof Brand>;

/**
 * The Branding page's state for the owner's admins: whether the owner's plan includes the
 * feature (never the caller's plan), the lowest plan that does, whether the operator suspended
 * the brand, and the stored brand, which is kept while the plan lacks the feature.
 */
export const BrandSettings = z.strictObject({
  available: z.boolean(),
  lowestPlan: PlanName,
  suspended: z.boolean(),
  brand: Brand.nullable(),
});
export type BrandSettings = z.infer<typeof BrandSettings>;

/** The brand the viewer draws on the bar, only when the owner's plan has it and it is not suspended. */
export const ViewerBrand = z.strictObject({
  name: z.string(),
  accentColor: z
    .string()
    .regex(/^#[0-9a-f]{6}$/)
    .nullable(),
  link: z.url().nullable(),
  logo: z
    .strictObject({
      /** On the artifact's own origin, never on the app's: `/__portifact/brand/<sha256>`. */
      url: z.url(),
      width: z.number().int().positive(),
      height: z.number().int().positive(),
    })
    .nullable(),
});
export type ViewerBrand = z.infer<typeof ViewerBrand>;

/** The reserved path on artifact origins that serves an owner's logo by its SHA-256. */
export const BRAND_LOGO_PATH = "/__portifact/brand/";

/** The R2 key of an owner's logo: outside `objects/`, which the storage reconciliation scans. */
export function brandLogoKey(ownerId: string, sha256: string): string {
  return `brands/${ownerId}/${sha256}`;
}
