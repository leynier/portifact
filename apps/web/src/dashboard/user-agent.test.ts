import { describe, expect, it } from "vitest";
import { describeUserAgent } from "./user-agent.ts";

describe("describeUserAgent", () => {
  it("names common browsers and systems, checking the ones that imitate others first", () => {
    const cases: [string, string | null, string | null][] = [
      [
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36 Edg/140.0.0.0",
        "Edge",
        "Windows",
      ],
      [
        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36 OPR/120.0.0.0",
        "Opera",
        "Linux",
      ],
      [
        "Mozilla/5.0 (X11; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0",
        "Firefox",
        "Linux",
      ],
      [
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15",
        "Safari",
        "macOS",
      ],
      [
        "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/140.0 Mobile/15E148 Safari/604.1",
        "Chrome",
        "iOS",
      ],
      [
        "Mozilla/5.0 (Linux; Android 15) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Mobile Safari/537.36",
        "Chrome",
        "Android",
      ],
      [
        "Mozilla/5.0 (X11; CrOS x86_64 16000.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36",
        "Chrome",
        "ChromeOS",
      ],
      ["curl/8.9.1", null, null],
    ];
    for (const [ua, browser, system] of cases) {
      expect(describeUserAgent(ua), ua).toEqual({ browser, system });
    }
  });

  it("knows nothing about a browser that sent no user agent", () => {
    expect(describeUserAgent(null)).toEqual({ browser: null, system: null });
  });
});
