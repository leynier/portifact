import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { MARK_CLOSE, MARK_OPEN } from "../src/search.ts";

// FTS5's snippet() looks at every hit in the row: on one large row a frequent word is very slow
// (measured 42 s for a 512 KiB file in the product's tests). Small rows keep it cheap.
describe("snippet cost", () => {
  async function snippetMs(rows: string[]): Promise<number> {
    await env.DB.prepare("delete from unicode_text").run();
    await env.DB.batch(
      rows.map((body) => env.DB.prepare("insert into unicode_text (body) values (?)").bind(body)),
    );
    const started = performance.now();
    await env.DB.prepare(
      `select snippet(unicode_text, 0, '${MARK_OPEN}', '${MARK_CLOSE}', '…', 24) as s from unicode_text where unicode_text match '"word"' limit 20`,
    ).all();
    return performance.now() - started;
  }

  it("grows with the hits in one row, and stays small with 4,000-character rows", async () => {
    const text = "word ".repeat(16 * 1024); // 80 KiB, one hit every five characters
    const single = await snippetMs([text]);
    const chunked = await snippetMs(text.match(/.{1,4000}/gs) ?? []);
    expect(single).toBeGreaterThan(10 * chunked);
    // Measured on 2026-11-10: 1,259 ms for the single row, 92 ms for 21 rows of 4,000 characters
    // (20 snippets). 42 s for one 512 KiB row in the product's tests, 3 ms once chunked.
  });
});
