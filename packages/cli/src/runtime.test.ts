import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { exitCodeFor } from "./errors.ts";
import { browserCommand, defaultConfigDir, defaultRuntime, launchDetached } from "./runtime.ts";

describe("defaultConfigDir", () => {
  it("follows each platform's convention", () => {
    expect(defaultConfigDir("linux", {}, "/home/ada")).toBe(
      join("/home/ada", ".config", "portifact"),
    );
    expect(defaultConfigDir("linux", { XDG_CONFIG_HOME: "/xdg" }, "/home/ada")).toBe(
      join("/xdg", "portifact"),
    );
    expect(defaultConfigDir("darwin", {}, "/Users/ada")).toBe(
      join("/Users/ada", "Library", "Application Support", "portifact"),
    );
    expect(defaultConfigDir("win32", { APPDATA: "C:/Users/ada/AppData/Roaming" }, "C:/x")).toBe(
      join("C:/Users/ada/AppData/Roaming", "portifact"),
    );
    expect(defaultConfigDir("win32", {}, "C:/Users/ada")).toBe(
      join("C:/Users/ada", "AppData", "Roaming", "portifact"),
    );
  });
});

describe("browserCommand", () => {
  it("passes the URL as one argument, never through a shell", () => {
    const url = "https://app.portifact.com/device?user_code=A&b=$(rm)";
    expect(browserCommand("darwin", url)).toEqual(["open", [url]]);
    expect(browserCommand("linux", url)).toEqual(["xdg-open", [url]]);
    expect(browserCommand("win32", url)).toEqual([
      "rundll32",
      ["url.dll,FileProtocolHandler", url],
    ]);
  });
});

describe("launchDetached", () => {
  it("resolves true when the program starts and false when it does not exist", async () => {
    expect(await launchDetached(process.execPath, ["-e", ""])).toBe(true);
    expect(await launchDetached("portifact-no-such-browser", [])).toBe(false);
  });
});

describe("defaultRuntime", () => {
  it("reads the process environment and has no OS credential store outside Bun", async () => {
    const runtime = defaultRuntime();
    expect(runtime.env).toBe(process.env);
    expect(runtime.secrets).toBeUndefined();
    const before = runtime.now();
    await runtime.sleep(1);
    expect(runtime.now()).toBeGreaterThanOrEqual(before);
  });
});

describe("exitCodeFor", () => {
  it("maps each error code to its documented exit code", () => {
    expect(exitCodeFor("invalid_input")).toBe(2);
    expect(exitCodeFor("unauthenticated")).toBe(3);
    expect(exitCodeFor("authorization_denied")).toBe(4);
    expect(exitCodeFor("authorization_expired")).toBe(4);
    expect(exitCodeFor("network_error")).toBe(1);
    expect(exitCodeFor("server_error")).toBe(1);
    expect(exitCodeFor("rate_limited")).toBe(1);
  });
});
