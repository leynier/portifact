import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";

/** Output sinks, injected so the CLI can be tested without touching the process streams. */
export interface Io {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
}

/** The shape of `Bun.secrets`: the OS credential store (Keychain, libsecret, Credential Manager). */
export interface SecretsApi {
  get(options: { service: string; name: string }): Promise<string | null>;
  set(options: { service: string; name: string; value: string }): Promise<void>;
  delete(options: { service: string; name: string }): Promise<boolean>;
}

/** Everything the commands take from the outside world, injected so tests control it. */
export interface Runtime {
  env: Readonly<Record<string, string | undefined>>;
  fetch: typeof fetch;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  /** Resolves true when a browser was launched. */
  openBrowser: (url: string) => Promise<boolean>;
  /** Undefined when the CLI does not run on Bun, which provides the OS credential store. */
  secrets: SecretsApi | undefined;
  /** Directory for the fallback credentials file. */
  configDir: string;
  /** A person is at the terminal, so opening a browser makes sense. */
  interactive: boolean;
}

export function defaultRuntime(): Runtime {
  const env = process.env;
  return {
    env,
    fetch: (input, init) => fetch(input, init),
    now: () => Date.now(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    openBrowser: (url) => {
      const [command, args] = browserCommand(process.platform, url);
      return launchDetached(command, args);
    },
    secrets: (globalThis as { Bun?: { secrets?: SecretsApi } }).Bun?.secrets,
    configDir: defaultConfigDir(process.platform, env, homedir()),
    interactive: Boolean(process.stderr.isTTY) && !env.CI,
  };
}

export function defaultConfigDir(
  platform: NodeJS.Platform,
  env: Readonly<Record<string, string | undefined>>,
  home: string,
): string {
  if (platform === "win32")
    return join(env.APPDATA || join(home, "AppData", "Roaming"), "portifact");
  if (platform === "darwin") return join(home, "Library", "Application Support", "portifact");
  return join(env.XDG_CONFIG_HOME || join(home, ".config"), "portifact");
}

// The URL is passed as a single argument, never through a shell, so it cannot inject commands.
export function browserCommand(platform: NodeJS.Platform, url: string): [string, string[]] {
  if (platform === "darwin") return ["open", [url]];
  if (platform === "win32") return ["rundll32", ["url.dll,FileProtocolHandler", url]];
  return ["xdg-open", [url]];
}

export function launchDetached(command: string, args: readonly string[]): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: "ignore", detached: true });
    child.once("error", () => resolve(false));
    child.once("spawn", () => {
      child.unref();
      resolve(true);
    });
  });
}
