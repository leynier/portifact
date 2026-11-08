/**
 * Version of the rendered output, stored per version as `rendererVersion`. Bump it whenever the
 * HTML, block ids or block map for the same source can change, so annotation anchors made against
 * an older rendering can be detected (plan section 8, "Anclas").
 */
export const RENDERER_VERSION = "1";
