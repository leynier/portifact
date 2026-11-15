# 0028 Image regions: comments on a rectangle of an image

- Status: accepted; built in one delivery (`feat(annotations): comment on a region of an image`, migration `0088_image_regions`: `annotation_threads.region`), switched off until the maintainer turns `IMAGE_REGIONS_ENABLED` on.
- Date: 2026-11-14
- Feature: plan section 8 lists "regiones de imagen" as out of scope of the first version, with no design. This record defines it. It builds on the anchor model ([docs/anchors.md](../anchors.md)), review mode and inline comments ([docs/security.md](../security.md), "Review mode" and "Inline comments") and the bridge protocol of [decision 0027](0027-edit-suggestions.md) ("Protocol and rollout").

## Question

A reviewer looking at a mockup wants to say "this button is too small" and point at the button, which is part of an image. Today they can pick the whole `img` element in element mode, which says nothing about where in the picture they mean. How does a reviewer mark a rectangle of an image and leave a thread on it, drawn over the image whenever the thread is shown, without letting the artifact draw or reach Portifact's controls, without changing who may comment or what it costs, without breaking released CLIs that validate thread responses strictly, and in a way that says whether the mark still fits after the artifact is published again?

## Decision in short

1. **A region is an element anchor plus a rectangle.** The thread's `target` stays a schema 1 element anchor of the `img` (unchanged, so every released client still parses it and shows the thread as a comment on the image). The rectangle goes in a new optional thread field, `region`, which names the image file and holds the rectangle in coordinates normalized to the image's box.
2. **The server names the bytes.** The client sends the image's file path in the version; the server checks it is a published `image/*` file of that version and stores its SHA-256 from `version_files`, never one a client sent.
3. **Drawn by the viewer while choosing, by the bridge when shown.** The rectangle is chosen in a layer the viewer draws over the frame (`FrameOverlay`), with the pointer or the keyboard; the bridge only reports the picked image and later draws the stored rectangle in its closed shadow root, like every highlight.
4. **Threads stay with their version.** A republish moves a region thread to the owner's history like any thread. The thread view of a history thread says whether the current version still has the same image bytes at that path, and the owner's viewer draws such threads on the current page: that is how a region survives a republish when the image is unchanged.
5. **Same rules as every comment.** Creating a region thread is creating a thread: the same authorization, comment scope, human check, rate limits and quotas, with the region's bytes counted in the thread's target bytes.
6. **Switched off.** Nothing about regions is reachable without `IMAGE_REGIONS_ENABLED="true"` on the app Worker (the API accepts `region`, the viewer offers it) and the content Worker (the bridge reports an image). Never in a deployed `wrangler.jsonc`. Only creating is gated: a region stored while the switch was on stays in thread views and exports after it is turned off, and the viewer then draws the thread as an outline of the whole image.

## Behavior

1. In element mode the reviewer picks an image. With regions on, the bridge's `element` message also says which file of the version the image shows (`image.path`), and the viewer's offer has two controls: "Comment" (the whole image, as before) and "Mark a region".
2. "Mark a region" draws a layer over the image's box as the bridge reported it, clipped to the frame. It starts with a rectangle over the middle half of the image. The reviewer drags to draw a new one, or uses the keyboard (below). "Comment on this region" (or Enter) opens the inline composer next to the rectangle; Cancel (or Escape) goes back to the artifact. The layer keeps the box it opened with: nothing the frame sends later moves it.
3. The composer posts the element target and the region. The thread's card says "Region of `<file>`", with the rectangle in percentages, everywhere threads are shown.
4. When the thread is shown, the viewer sends the region with the highlight, and the bridge draws a box over that part of the image (and an outline when it is selected), in place of the element outline. Clicking inside the box selects the thread, as for any highlight.

## Anchor shape

```ts
// `packages/contracts/src/anchors.ts`
ImageRegionRequest = { x, y, width, height, image: { path } } // what clients send
ImageRegion = { x, y, width, height, image: { path, sha256 } } // what is stored
ImageRegionView = ImageRegion & { currentImage?: "unchanged" | "changed" } // what threads show
```

- `x` and `y` are the rectangle's top left corner and `width` and `height` its size, as fractions of the image element's box (0 is the left or top edge, 1 the right or bottom edge), so the rectangle follows the image wherever and however large the page draws it. Values have at most four decimals; `width` and `height` are at least `IMAGE_REGION_LIMITS.minExtent` (0.01), and `x + width` and `y + height` are at most 1.
- `image.path` is the file the image shows, as a path in the version (`AnchorPath`). The bridge derives it from the image's `currentSrc` only when that URL is on the artifact's own origin; any other image (another origin, a `data:` or `blob:` URL) offers no region.
- `image.sha256` is the file's SHA-256 in that version, filled by the server.
- The target must be an element anchor whose `tagName` is `img`, on the same page (`target.path`) the region was drawn on.

Released clients parse `AnnotationThreadView` with `z.object`, which strips unknown keys, so they keep working and see an element comment on the image. `CreateThreadRequest` and the MCP `create_annotation` input accept `region`; a server that predates it refuses the key, as it should.

## Resolution and orphan rules

The bridge resolves the element anchor exactly as today ([docs/anchors.md](../anchors.md), "Confidence"), then:

| Element found                                                                | Result                                         |
| ---------------------------------------------------------------------------- | ---------------------------------------------- |
| An `img` whose `currentSrc` maps to `region.image.path`                      | The element's confidence; the region is drawn  |
| An element that is not an `img`, or an `img` showing another file or nothing | `orphaned` with the new reason `image_changed` |
| None, or several                                                             | `orphaned` (`not_found`, `ambiguous`)          |

Within one version the path decides the bytes, so the bridge never fetches or hashes the image. Across versions the server decides: for a thread of another version than the current one, the thread view sets `region.currentImage` to `unchanged` when the current version has a published file at `region.image.path` with the stored SHA-256, and to `changed` otherwise (including a file that is gone). The owner's viewer (the only role that sees other versions' threads) draws history region threads marked `unchanged` on the current page, and lists `changed` ones without a location. A current thread carries no `currentImage`.

The region is mapped to the element's border box as `getBoundingClientRect` reports it. For the default `object-fit: fill` without padding that is the picture itself; a page that pads an image or fits it with `contain` or `cover` gets the rectangle over the element's box, not the picture, which the reviewer sees while drawing (non-goal below).

## Bridge messages

Both protocol versions (2 and 3) gain optional fields; no version bump, because both sides send them only with the switch on, and the bridge and the viewer are released together.

- Bridge to viewer, `element`: optional `image: { path }`, sent only when the content Worker's script tag says `data-image-regions="true"` and the picked element is an `img` on the artifact's origin. A forged `image` only offers "Mark a region"; the server checks the file.
- Viewer to bridge, `highlights`: each highlight may carry `region: { x, y, width, height, path }`, sent only with `ReviewStart.imageRegions`.
- Bridge to viewer, `resolved`: the reason may be `image_changed`.

Nothing else changes: every rule of "Review mode" and "Inline comments" holds, rectangles from the frame stay untrusted hints clamped by `visibleRect`, and the region layer is the viewer's own UI, never inside the artifact. The rectangle the reviewer draws is computed by the viewer from its own pointer or keys over the box it froze; the frame never reports a region.

## Keyboard and screen readers

The region layer is a labelled group with one focusable surface (not `role="application"`), which takes focus when it opens, with its instructions as its description and a polite live text that says the rectangle in percentages after each change:

- Arrow keys move the rectangle by 2% of the image; with Shift they resize it (Right and Down grow, Left and Up shrink), never below the minimum or past an edge.
- Enter opens the composer for the rectangle; Escape cancels and returns focus to the frame.
- The visible "Comment on this region" and "Cancel" buttons follow it in the tab order, so no key is required that a button does not also offer, apart from moving and resizing, which the keys do and a pointer drag does.

The drawn rectangle has a visible outline in the text color and a translucent fill, meeting the non-text contrast rule of [docs/accessibility.md](../accessibility.md).

## Limits

- One rectangle per thread; at least 1% of the image on each side; four decimals.
- The image must be a published file of the version with an `image/*` content type; no other element can hold a region.
- The region's JSON is at most a few hundred bytes plus the path (1,024 characters at most). Its bytes are added to the thread's `target_bytes`, so the owner's annotation bytes count it through the existing triggers, and the target plus the region must fit the 8 KiB target limit (`invalid_input` otherwise).

## Non-goals

- Drawing tools: no freehand, ellipses, arrows, colors or several rectangles in one thread.
- Inline `<svg>`, `<canvas>`, `<video>`, CSS background images and images from other origins.
- Mapping through `object-fit`, `object-position` or padding (the bridge reads no computed styles).
- Carrying threads into a new version: threads stay with their version, as every thread kind does; only the owner's history display uses `currentImage`.
- A CLI or MCP way to draw: they can send a `region` they already know (the CLI's `--region` file, the MCP input), and they show regions where they show threads.

## Rejected

- **A new anchor kind `image`.** Cleaner in the schema, but every released CLI validates `target` with a strict union and would fail on the first region thread of an artifact. Keeping the element anchor degrades to "a comment on the image" instead.
- **Page coordinates** (the element anchor's `rect`). They change with the window size and the layout; normalized coordinates of the image do not.
- **Hashing the image in the browser.** Within a version the path decides the bytes, and across versions the server already holds every file's SHA-256, so the bridge fetches nothing.
- **Drawing the rectangle in the bridge.** The artifact shares the bridge's window; the viewer must draw every control (security.md, "Inline comments").

## Terms and Privacy

A region is comment metadata: four numbers and the path of a file the artifact's author published, with its hash. It identifies nobody, adds no processor, cookie or retention period, and goes wherever the thread's target already goes (exports, account deletion, restores). The Terms, Privacy and DPA pages already describe comment targets as part of comments, so they need no change and `TERMS_VERSION` stays.
