import { ArtifactType } from "@portifact/contracts";
import { Command, CommanderError, InvalidArgumentError, Option } from "commander";
import packageJson from "../package.json" with { type: "json" };
import {
  changeAccess,
  info,
  type LifecycleAction,
  lifecycle,
  list,
  showAccess,
} from "./artifacts.ts";
import { login, logout, whoami, writeJson } from "./commands.ts";
import { CliError, EXIT, exitCodeFor } from "./errors.ts";
import { messages } from "./messages.ts";
import { publish } from "./publish.ts";
import { defaultRuntime, type Io, type Runtime } from "./runtime.ts";

export type { Io } from "./runtime.ts";

export const version: string = packageJson.version;

export const notice = messages.notice;

const EXIT_CODES_HELP = `
Exit codes:
  0  success
  1  failure: network, unexpected server answer, rate limit, upload or cancelled
  2  invalid usage or input
  3  not signed in, or the session ended
  4  login denied or expired
  5  artifact or upload not found, or not allowed
  6  conflict with the artifact's state (version conflict, incomplete upload, archived)
  7  limit reached (quota, traffic, account too new for public access)

With --json, a failure prints {"error":{"code","message"}} on stdout.
`;

const PUBLISH_HELP = `
The type is inferred from the path: a folder or .html file is a site, .md is markdown and
.txt is text. A single HTML file is published as the site's index.html. Folders leave out
.git, node_modules, caches and files that may hold secrets (.env, keys, credentials).
Publishing a new version keeps the artifact's access as it is.

ZIP files and --source (private sources) are not supported yet; they arrive in a later release.
`;

const LIST_MAX = 100;

/** Runs the CLI with the given arguments (without the executable and script) and returns the exit code. */
export async function run(
  argv: readonly string[],
  io: Io,
  runtime: Runtime = defaultRuntime(),
): Promise<number> {
  let exitCode: number = EXIT.ok;

  // Each command reports its own failure, as JSON on stdout with --json. Commander passes the
  // arguments first, then the options and the command; commands take the options first.
  const execute =
    <T extends { json?: boolean }, A extends unknown[]>(
      command: (io: Io, runtime: Runtime, options: T, ...args: A) => Promise<void>,
    ) =>
    async (...received: unknown[]) => {
      const args = received.slice(0, -2) as A;
      const options = received.at(-2) as T;
      try {
        await command(io, runtime, options, ...args);
      } catch (error) {
        if (!(error instanceof CliError)) throw error;
        exitCode = exitCodeFor(error.code);
        if (options.json) {
          writeJson(io, { error: { code: error.code, message: error.message } });
        } else {
          io.stderr(`${messages.errorPrefix} ${error.message}\n`);
        }
      }
    };

  const program = new Command()
    .name("portifact")
    .description("Publish and share static artifacts.")
    .version(version, "-v, --version", "Print the installed version")
    .helpOption("-h, --help", "Show help")
    .helpCommand(false)
    // Each command owns the options written after it (see `access` and its subcommands).
    .enablePositionalOptions()
    .exitOverride()
    .configureOutput({ writeOut: io.stdout, writeErr: io.stderr })
    .addHelpText("after", EXIT_CODES_HELP)
    .action(() => {
      io.stdout(notice);
    });

  program
    .command("login")
    .description("Sign in to Portifact on this device")
    .option("--no-browser", "Do not open the sign-in page in a browser")
    .option("--json", "Print the result as JSON")
    .action(
      execute((io, runtime, options: { browser: boolean; json?: boolean }) =>
        login(io, runtime, { browser: options.browser, json: options.json === true }),
      ),
    );

  program
    .command("logout")
    .description("Revoke this device's tokens and remove them")
    .option("--json", "Print the result as JSON")
    .action(
      execute((io, runtime, options: { json?: boolean }) =>
        logout(io, runtime, { json: options.json === true }),
      ),
    );

  program
    .command("whoami")
    .description("Show the account this device is signed in to")
    .option("--json", "Print the result as JSON")
    .action(
      execute((io, runtime, options: { json?: boolean }) =>
        whoami(io, runtime, { json: options.json === true }),
      ),
    );

  program
    .command("publish")
    .description("Publish a file or folder as a new artifact, or as a new version of one")
    .argument("<path>", "file or folder to publish")
    .addOption(
      new Option("--type <type>", "artifact type; inferred from the path when omitted").choices(
        ArtifactType.options,
      ),
    )
    .option("--name <name>", "name shown in your artifact list (default: the file or folder name)")
    .option("--entry <path>", "page a site opens first (default: index.html)")
    .option("--artifact <id>", "publish a new version of this artifact")
    .option("--dry-run", "print the manifest without uploading or signing in")
    .option("--json", "Print the result as JSON")
    .addHelpText("after", PUBLISH_HELP)
    .action(
      execute(
        (
          io,
          runtime,
          options: {
            type?: ArtifactType;
            name?: string;
            entry?: string;
            artifact?: string;
            dryRun?: boolean;
            json?: boolean;
          },
          path: string,
        ) =>
          publish(io, runtime, path, {
            type: options.type,
            name: options.name,
            entry: options.entry,
            artifact: options.artifact,
            dryRun: options.dryRun === true,
            json: options.json === true,
          }),
      ),
    );

  program
    .command("list")
    .description("List your artifacts, most recently updated first")
    .option("--limit <n>", `artifacts per page, 1 to ${LIST_MAX} (default: 50)`, parseLimit)
    .option("--cursor <cursor>", "continue from where the previous page ended")
    .option("--json", "Print the result as JSON")
    .action(
      execute((io, runtime, options: { limit?: number; cursor?: string; json?: boolean }) =>
        list(io, runtime, {
          limit: options.limit,
          cursor: options.cursor,
          json: options.json === true,
        }),
      ),
    );

  program
    .command("info")
    .description("Show an artifact's details")
    .argument("<id>", "artifact ID")
    .option("--json", "Print the result as JSON")
    .action(
      execute((io, runtime, options: { json?: boolean }, id: string) =>
        info(io, runtime, id, { json: options.json === true }),
      ),
    );

  const lifecycleCommands: [LifecycleAction, string][] = [
    ["renew", "Keep an artifact published for another 30 days"],
    ["archive", "Stop serving an artifact; its owner can restore it for six months"],
    ["restore", "Publish an archived artifact again"],
  ];
  for (const [action, description] of lifecycleCommands) {
    program
      .command(action)
      .description(description)
      .argument("<id>", "artifact ID")
      .option("--json", "Print the result as JSON")
      .action(
        execute((io, runtime, options: { json?: boolean }, id: string) =>
          lifecycle(io, runtime, action, id, { json: options.json === true }),
        ),
      );
  }

  program
    .command("delete")
    .description("Delete an artifact permanently, after a confirmation")
    .argument("<id>", "artifact ID")
    .option("-y, --yes", "confirm without a prompt; required when no terminal can answer")
    .option("--json", "Print the result as JSON")
    .action(
      execute((io, runtime, options: { yes?: boolean; json?: boolean }, id: string) =>
        lifecycle(io, runtime, "delete", id, {
          yes: options.yes === true,
          json: options.json === true,
        }),
      ),
    );

  const access = program
    .command("access")
    .description("Show or change who can open an artifact")
    // Options after a subcommand belong to it, so `access set ID public --json` prints JSON.
    .enablePositionalOptions()
    .argument("<id>", "artifact ID")
    .option("--json", "Print the result as JSON")
    .action(
      execute((io, runtime, options: { json?: boolean }, id: string) =>
        showAccess(io, runtime, id, { json: options.json === true }),
      ),
    );
  access
    .command("set")
    .description(
      "Set the access mode: restricted (you and listed readers), authenticated or public",
    )
    .argument("<id>", "artifact ID")
    .argument("<mode>", "restricted, authenticated or public")
    .option("--json", "Print the result as JSON")
    .action(
      execute((io, runtime, options: { json?: boolean }, id: string, mode: string) =>
        changeAccess(io, runtime, id, { kind: "mode", mode }, { json: options.json === true }),
      ),
    );
  for (const kind of ["add", "remove"] as const) {
    access
      .command(kind)
      .description(
        kind === "add"
          ? "Let these email addresses open a restricted artifact"
          : "Remove these email addresses from the readers",
      )
      .argument("<id>", "artifact ID")
      .argument("<emails...>", "reader email addresses")
      .option("--json", "Print the result as JSON")
      .action(
        execute((io, runtime, options: { json?: boolean }, id: string, emails: string[]) =>
          changeAccess(io, runtime, id, { kind, emails }, { json: options.json === true }),
        ),
      );
  }

  for (const command of [...program.commands, ...access.commands]) {
    command.exitOverride().configureOutput({ writeOut: io.stdout, writeErr: io.stderr });
  }

  try {
    await program.parseAsync([...argv], { from: "user" });
    return exitCode;
  } catch (error) {
    if (error instanceof CommanderError) {
      return error.exitCode === 0 ? EXIT.ok : EXIT.usage;
    }
    throw error;
  }
}

function parseLimit(value: string): number {
  const limit = Number(value);
  if (!Number.isInteger(limit) || limit < 1 || limit > LIST_MAX) {
    throw new InvalidArgumentError(messages.errors.invalidLimit(LIST_MAX));
  }
  return limit;
}
