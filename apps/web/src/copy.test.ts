// @vitest-environment happy-dom
import { LOCALE_CODES } from "@portifact/contracts/locales";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type Clipboard, setupCopyButtons } from "./copy.ts";
import { LANDING_MESSAGES, landingMessages } from "./landing-messages.ts";

function render(html: string): void {
  document.body.innerHTML = html;
}

const markup = `
  <code id="cmd">  curl -fsSL https://portifact.com/install | bash  </code>
  <button type="button" data-copy-target="cmd" data-copy-status="status">Copy</button>
  <p id="status"></p>
`;

function button(): HTMLButtonElement {
  const element = document.querySelector("button");
  if (!element) throw new Error("button not rendered");
  return element;
}

async function click(): Promise<void> {
  button().click();
  await vi.waitFor(() => expect(document.getElementById("status")?.textContent).not.toBe(""));
}

describe("copy buttons", () => {
  beforeEach(() => vi.useFakeTimers({ shouldAdvanceTime: true }));
  afterEach(() => {
    vi.useRealTimers();
    document.documentElement.lang = "en";
  });

  it("copies the trimmed target text, confirms it and restores the label", async () => {
    render(markup);
    const clipboard: Clipboard = { writeText: vi.fn(async () => {}) };

    expect(setupCopyButtons(document, clipboard)).toBe(1);
    await click();

    expect(clipboard.writeText).toHaveBeenCalledWith(
      "curl -fsSL https://portifact.com/install | bash",
    );
    expect(button().textContent).toBe("Copied");
    expect(document.getElementById("status")?.textContent).toBe("Copied to the clipboard.");

    vi.advanceTimersByTime(2000);
    expect(button().textContent).toBe("Copy");
  });

  it("tells the user to copy manually when the clipboard rejects", async () => {
    render(markup);
    setupCopyButtons(document, { writeText: () => Promise.reject(new Error("denied")) });

    await click();

    expect(button().textContent).toBe("Copy");
    expect(document.getElementById("status")?.textContent).toContain("Copy failed");
  });

  it("explains that copying is unavailable without a clipboard", async () => {
    render(markup);
    setupCopyButtons(document, undefined);

    await click();

    expect(document.getElementById("status")?.textContent).toContain("not available");
  });

  it("does nothing harmful when the target element is missing", async () => {
    render(
      `<button type="button" data-copy-target="missing" data-copy-status="status">Copy</button><p id="status"></p>`,
    );
    const clipboard: Clipboard = { writeText: vi.fn(async () => {}) };
    setupCopyButtons(document, clipboard);

    await click();

    expect(clipboard.writeText).not.toHaveBeenCalled();
  });

  it("works without a status element and restores an empty label", async () => {
    render(
      `<code id="cmd">npx skills add leynier/portifact</code><button type="button" data-copy-target="cmd"></button>`,
    );
    const clipboard: Clipboard = { writeText: vi.fn(async () => {}) };
    setupCopyButtons(document, clipboard);

    button().click();
    await vi.waitFor(() => expect(button().textContent).toBe("Copied"));
    vi.advanceTimersByTime(2000);

    expect(clipboard.writeText).toHaveBeenCalledWith("npx skills add leynier/portifact");
    expect(button().textContent).toBe("");
  });

  it("does not copy an empty target", async () => {
    render(
      `<code id="cmd">   </code><button type="button" data-copy-target="cmd" data-copy-status="status">Copy</button><p id="status"></p>`,
    );
    const clipboard: Clipboard = { writeText: vi.fn(async () => {}) };
    setupCopyButtons(document, clipboard);

    await click();

    expect(clipboard.writeText).not.toHaveBeenCalled();
  });

  it("ignores buttons without a copy target", () => {
    render(`<button type="button">Other</button>`);
    expect(setupCopyButtons(document, undefined)).toBe(0);
  });

  it("announces in Spanish on a Spanish page and restores the translated label", async () => {
    document.documentElement.lang = "es";
    render(markup.replace(">Copy<", ">Copiar<"));
    setupCopyButtons(document, { writeText: vi.fn(async () => {}) }, landingMessages(document));

    await click();

    expect(button().textContent).toBe("Copiado");
    expect(document.getElementById("status")?.textContent).toBe("Copiado al portapapeles.");
    vi.advanceTimersByTime(2000);
    expect(button().textContent).toBe("Copiar");
  });

  it("tells a Spanish reader to copy manually when copying fails", async () => {
    document.documentElement.lang = "es";
    render(markup);
    setupCopyButtons(
      document,
      { writeText: () => Promise.reject(new Error("denied")) },
      landingMessages(document),
    );

    await click();

    expect(document.getElementById("status")?.textContent).toBe(LANDING_MESSAGES.es.copyFailed);
  });
});

describe("landingMessages", () => {
  afterEach(() => {
    document.documentElement.lang = "en";
  });

  it("picks the messages of the page's language", () => {
    document.documentElement.lang = "es";
    expect(landingMessages(document)).toBe(LANDING_MESSAGES.es);
    document.documentElement.lang = "en";
    expect(landingMessages(document)).toBe(LANDING_MESSAGES.en);
  });

  it("has the messages of every language, each translated", () => {
    for (const code of LOCALE_CODES) {
      document.documentElement.lang = code;
      expect(landingMessages(document)).toBe(LANDING_MESSAGES[code]);
      if (code !== "en") expect(LANDING_MESSAGES[code].copied).not.toBe(LANDING_MESSAGES.en.copied);
    }
  });

  it("falls back to English for a language it does not have", () => {
    for (const lang of ["", "it", "ES", "es-MX", "zh-TW", "pt"]) {
      document.documentElement.lang = lang;
      expect(landingMessages(document)).toBe(LANDING_MESSAGES.en);
    }
  });

  it("has every message in every language, without trailing spaces or em dashes", () => {
    const keys = Object.keys(LANDING_MESSAGES.en).sort();
    for (const messages of Object.values(LANDING_MESSAGES)) {
      expect(Object.keys(messages).sort()).toEqual(keys);
      for (const text of Object.values(messages)) {
        expect(text.trim()).toBe(text);
        expect(text).not.toBe("");
        expect(text).not.toMatch(/[—–]/);
      }
    }
  });
});
