import { Command, CommanderError } from "commander";
import packageJson from "../package.json" with { type: "json" };
import { login, logout, whoami, writeJson } from "./commands.ts";
import { CliError, EXIT, exitCodeFor } from "./errors.ts";
import { messages } from "./messages.ts";
import { defaultRuntime, type Io, type Runtime } from "./runtime.ts";

export type { Io } from "./runtime.ts";

export const version: string = packageJson.version;

export const notice = messages.notice;

/**
 * Runs the CLI with the given arguments (without the executable and script) and returns the exit
 * code. Exit codes: 0 success, 1 failure, 2 invalid usage, 3 not signed in or session ended,
 * 4 login denied or expired.
 */
export async function run(
  argv: readonly string[],
  io: Io,
  runtime: Runtime = defaultRuntime(),
): Promise<number> {
  let exitCode: number = EXIT.ok;

  // Each command reports its own failure, as JSON on stdout with --json.
  const execute =
    <T extends { json?: boolean }>(
      command: (io: Io, runtime: Runtime, options: T) => Promise<void>,
    ) =>
    async (options: T) => {
      try {
        await command(io, runtime, options);
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
    .exitOverride()
    .configureOutput({ writeOut: io.stdout, writeErr: io.stderr })
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

  for (const command of program.commands) {
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
