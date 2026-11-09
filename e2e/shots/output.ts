// Turns what the shots run captured into landing page files: WebP images (encoded by Chromium,
// so no image library is needed) and the terminal transcripts written into apps/web/index.html
// between `<!-- shots:<name> -->` and `<!-- /shots:<name> -->` markers.
import { readFileSync, writeFileSync } from "node:fs";
import type { Browser } from "@playwright/test";
import type { CliRun } from "./cli.ts";

export const REPO = new URL("../../", import.meta.url).pathname;
export const IMAGE_DIR = `${REPO}apps/web/src/assets/landing/`;
const LANDING = `${REPO}apps/web/index.html`;

/** WebP quality: text stays sharp and each 2x image stays well under 200 KB. */
const QUALITY = 0.86;

/**
 * Writes `<name>-<scheme>@2x.webp` from a 2x PNG screenshot and `<name>-<scheme>.webp` scaled
 * down to 1x, and returns their sizes in bytes.
 */
export async function writeWebp(
  browser: Browser,
  png: Buffer,
  name: string,
  scheme: "light" | "dark",
): Promise<number[]> {
  const page = await browser.newPage();
  try {
    const encoded = await page.evaluate(
      async ({ data, quality }) => {
        const image = new Image();
        image.src = `data:image/png;base64,${data}`;
        await image.decode();
        const encode = (scale: number) => {
          const canvas = document.createElement("canvas");
          canvas.width = Math.round(image.naturalWidth * scale);
          canvas.height = Math.round(image.naturalHeight * scale);
          const context = canvas.getContext("2d");
          if (!context) throw new Error("no 2d context");
          context.imageSmoothingQuality = "high";
          context.drawImage(image, 0, 0, canvas.width, canvas.height);
          const url = canvas.toDataURL("image/webp", quality);
          if (!url.startsWith("data:image/webp"))
            throw new Error("this browser cannot encode WebP");
          return url.slice(url.indexOf(",") + 1);
        };
        return { x2: encode(1), x1: encode(0.5) };
      },
      { data: png.toString("base64"), quality: QUALITY },
    );
    const x2 = Buffer.from(encoded.x2, "base64");
    const x1 = Buffer.from(encoded.x1, "base64");
    writeFileSync(`${IMAGE_DIR}${name}-${scheme}@2x.webp`, x2);
    writeFileSync(`${IMAGE_DIR}${name}-${scheme}.webp`, x1);
    return [x1.length, x2.length];
  } finally {
    await page.close();
  }
}

export function escapeHtml(text: string): string {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

/**
 * The run as production shows it: the stack's hosts become portifact.com and portifact.dev, and
 * the line the CLI prints only when its server is overridden for tests is left out. The scratch
 * folder the commands ran in reads as the folder the terminal shows.
 */
export function asProduction(text: string, work?: string): string {
  return (work ? text.replaceAll(work, "~/checkout") : text)
    .replaceAll("portifact-content.test", "portifact.dev")
    .replaceAll("app.portifact.test", "app.portifact.com")
    .split("\n")
    .filter((line) => !line.startsWith("Using the Portifact server at "))
    .join("\n");
}

export interface TranscriptOptions {
  /** The folder the CLI ran in. */
  work?: string;
  /** The hero shows the output after the command, under motion-safe only. */
  animate?: boolean;
}

/**
 * One command and its output as terminal markup: the prompt and progress (stderr) muted, results
 * (stdout) in full color, in the order the CLI wrote them.
 */
export function transcript(run: CliRun, options: TranscriptOptions = {}): string {
  if (run.code !== 0) throw new Error(`${run.command} failed: ${JSON.stringify(run.output)}`);
  const command = escapeHtml(asProduction(run.command, options.work));
  const body = run.output
    .map((chunk) => ({ ...chunk, text: asProduction(chunk.text, options.work) }))
    .filter((chunk) => chunk.text !== "")
    .map((chunk) =>
      chunk.stream === "stderr"
        ? `<span class="text-terminal-muted">${escapeHtml(chunk.text)}</span>`
        : escapeHtml(chunk.text),
    )
    .join("")
    .replace(/\n$/, "");
  const output = options.animate
    ? `<span class="block motion-safe:animate-rise motion-safe:animate-delay-4">${body}</span>`
    : body;
  return `<span class="text-terminal-muted">$</span> ${command}\n${output}`;
}

/** Replaces the content between the markers of each named region of the landing page. */
export function writeRegions(regions: Record<string, string>): void {
  let html = readFileSync(LANDING, "utf8");
  for (const [name, content] of Object.entries(regions)) {
    const start = `<!-- shots:${name} -->`;
    const end = `<!-- /shots:${name} -->`;
    const from = html.indexOf(start);
    const to = html.indexOf(end);
    if (from < 0 || to < from) throw new Error(`index.html has no ${start} region`);
    html = `${html.slice(0, from + start.length)}${content}${html.slice(to)}`;
  }
  writeFileSync(LANDING, html);
}
