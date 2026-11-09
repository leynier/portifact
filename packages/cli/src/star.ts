// After a publish, the CLI may ask once per machine for a GitHub star, and only when the command
// it shows would work: GitHub CLI is installed and signed in, and the repository is not starred
// yet. The CLI only reads (`gh auth status`, `gh api user/starred/...`); it never stars by itself.
// Nothing here is sent to Portifact, and nothing here may fail a publish.
import { constants } from "node:fs";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { messages } from "./messages.ts";
import type { Runtime } from "./runtime.ts";

export const STAR_REPOSITORY = "leynier/portifact";
export const STAR_COMMAND: readonly string[] = ["gh", "repo", "star", STAR_REPOSITORY];
/** Set to any value to never see the suggestion. */
export const NO_STAR_PROMPT_ENV = "PORTIFACT_NO_STAR_PROMPT";
/** Written in the config directory once the suggestion was shown or the repository was starred. */
export const STAR_FLAG_FILE = "star-suggestion.json";
/** Each `gh` call gets this long, so the checks add at most about 3 seconds to a publish. */
export const GH_TIMEOUT_MS = 1_500;

// No prompts, update notices or colors from gh: the CLI reads only its exit code and status line.
const GH_ENV = {
  GH_PROMPT_DISABLED: "1",
  GH_NO_UPDATE_NOTIFIER: "1",
  GH_NO_EXTENSION_UPDATE_NOTIFIER: "1",
  NO_COLOR: "1",
};

export interface StarSuggestion {
  kind: "star_repository";
  message: string;
  command: string[];
}

export interface PendingSuggestion {
  suggestion: StarSuggestion;
  /** Records that the suggestion was shown, so it never appears again on this machine. */
  markShown: () => Promise<void>;
}

type StarState = "starred" | "not_starred" | "unknown";

/** The suggestion to show after this publish, or undefined. Never throws. */
export async function starSuggestion(runtime: Runtime): Promise<PendingSuggestion | undefined> {
  try {
    if (runtime.env.CI || runtime.env[NO_STAR_PROMPT_ENV]) return undefined;
    const flag = join(runtime.configDir, STAR_FLAG_FILE);
    // A flag that cannot be read or written could repeat the suggestion, so it is not shown.
    if ((await flagState(flag)) !== "absent") return undefined;
    if (!(await writable(runtime.configDir))) return undefined;

    const state = await starState(runtime);
    if (state === "starred") {
      await writeFlag(flag, "starred", runtime.now());
      return undefined;
    }
    // Without gh, signed out or offline, the command would not work now; a later publish retries.
    if (state === "unknown") return undefined;

    const command = [...STAR_COMMAND];
    return {
      suggestion: {
        kind: "star_repository",
        message: messages.starSuggestion(command.join(" ")),
        command,
      },
      markShown: () => writeFlag(flag, "shown", runtime.now()),
    };
  } catch {
    return undefined;
  }
}

async function flagState(path: string): Promise<"absent" | "present" | "unreadable"> {
  try {
    await readFile(path);
    return "present";
  } catch (error) {
    return isNotFound(error) ? "absent" : "unreadable";
  }
}

async function writable(dir: string): Promise<boolean> {
  try {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await access(dir, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

async function writeFlag(path: string, state: "shown" | "starred", now: number): Promise<void> {
  try {
    const body = { version: 1, state, at: new Date(now).toISOString() };
    await writeFile(path, `${JSON.stringify(body)}\n`, { mode: 0o600 });
  } catch {
    // The suggestion may then appear once more; that is better than failing a publish.
  }
}

async function starState(runtime: Runtime): Promise<StarState> {
  try {
    const auth = await runtime.process("gh", ["auth", "status", "--hostname", "github.com"], {
      timeoutMs: GH_TIMEOUT_MS,
      env: GH_ENV,
    });
    if (auth.code !== 0) return "unknown";
    // GitHub answers 204 when the user starred the repository and 404 when not.
    const starred = await runtime.process(
      "gh",
      ["api", "--silent", "--include", `user/starred/${STAR_REPOSITORY}`],
      { timeoutMs: GH_TIMEOUT_MS, env: GH_ENV },
    );
    const status = /^HTTP\/[\d.]+ (\d{3})/.exec(starred.stdout)?.[1];
    if (status === "204" && starred.code === 0) return "starred";
    if (status === "404") return "not_starred";
    return "unknown";
  } catch {
    return "unknown";
  }
}

function isNotFound(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
