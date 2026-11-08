import { describe, expect, it } from "vitest";
import { classifyUrl } from "./urls.ts";

describe("classifyUrl", () => {
  it.each([
    "page.md",
    "./images/a.png",
    "../up.html",
    "/root.txt",
    "#section",
    "?q=1",
    "",
    "java%09script:alert(1)",
  ])("treats %j as a path on the artifact", (url) => {
    expect(classifyUrl(url)).toBe("local");
  });

  it.each([
    "https://example.com/x",
    "HTTP://EXAMPLE.COM",
    "mailto:someone@example.com",
    "//evil.example/x.png",
    "/\\evil.example/x.png",
    "\\\\evil.example/x.png",
    "/\t/evil.example/x.png",
    " https://example.com",
    "http://artifact.invalid/",
  ])("treats %j as another origin, as a browser resolves it", (url) => {
    expect(classifyUrl(url)).toBe("remote");
  });

  it.each([
    "javascript:alert(1)",
    "JaVaScRiPt:alert(1)",
    "java\tscript:alert(1)",
    " javascript:alert(1)",
    "\u0001javascript:alert(1)",
    "vbscript:msgbox(1)",
    "data:text/html,<script>alert(1)</script>",
    "data:image/png;base64,AAAA",
    "file:///etc/passwd",
    "ftp://example.com/",
    "blob:https://example.com/uuid",
    "about:blank",
    "tel:+123",
    "http://[::1",
  ])("rejects %j", (url) => {
    expect(classifyUrl(url)).toBeUndefined();
  });
});
