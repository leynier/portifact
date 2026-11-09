/**
 * Version of the rendered output, a positive integer kept as a string and stored per version as
 * `rendererVersion`. Bump it whenever the HTML, block ids or block map for the same source can
 * change, so annotation anchors made against an older rendering can be detected (plan section 8,
 * "Anclas").
 */
export const RENDERER_VERSION = "3";

/**
 * Oldest renderer version without a known security flaw. Published documents are rendered once
 * and kept as they are, even when the renderer changes; a security fix raises this to the new
 * `RENDERER_VERSION`, and the maintenance job re-renders every live document below it (plan
 * section 7: security fixes apply even if they change the presentation).
 */
export const SECURE_RENDERER_VERSION = "1";
