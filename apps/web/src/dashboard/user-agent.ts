// A short, human description of a browser from its user agent, such as "Firefox" and "macOS".
// Only common browsers and systems are named; anything else is unknown rather than guessed.

export interface DeviceDescription {
  browser: string | null;
  system: string | null;
}

// Order matters: Edge and Opera also say Chrome, and Chrome also says Safari.
const BROWSERS: [RegExp, string][] = [
  [/\bEdg(?:e|A|iOS)?\//, "Edge"],
  [/\bOPR\//, "Opera"],
  [/\b(?:Firefox|FxiOS)\//, "Firefox"],
  [/\b(?:Chrome|CriOS)\//, "Chrome"],
  [/\bVersion\/[\d.]+.*\bSafari\//, "Safari"],
];

const SYSTEMS: [RegExp, string][] = [
  [/\b(?:iPhone|iPad|iPod)\b/, "iOS"],
  [/\bAndroid\b/, "Android"],
  [/\bCrOS\b/, "ChromeOS"],
  [/\bWindows\b/, "Windows"],
  [/\bMac OS X\b|\bMacintosh\b/, "macOS"],
  [/\bLinux\b/, "Linux"],
];

export function describeUserAgent(userAgent: string | null): DeviceDescription {
  const ua = userAgent ?? "";
  return {
    browser: BROWSERS.find(([pattern]) => pattern.test(ua))?.[1] ?? null,
    system: SYSTEMS.find(([pattern]) => pattern.test(ua))?.[1] ?? null,
  };
}
