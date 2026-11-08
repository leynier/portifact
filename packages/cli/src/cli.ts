import { Command, CommanderError } from "commander";
import packageJson from "../package.json" with { type: "json" };

/** Output sinks, injected so the CLI can be tested without touching the process streams. */
export interface Io {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
}

export const version: string = packageJson.version;

export const notice = [
  "Portifact is in early development. No commands are available yet.",
  "Follow progress at https://github.com/leynier/portifact",
  "",
].join("\n");

/** Runs the CLI with the given arguments (without the executable and script) and returns the exit code. */
export async function run(argv: readonly string[], io: Io): Promise<number> {
  const program = new Command()
    .name("portifact")
    .description("Publish and share static artifacts.")
    .version(version, "-v, --version", "Print the installed version")
    .helpOption("-h, --help", "Show help")
    .exitOverride()
    .configureOutput({ writeOut: io.stdout, writeErr: io.stderr })
    .action(() => {
      io.stdout(notice);
    });

  try {
    await program.parseAsync([...argv], { from: "user" });
    return 0;
  } catch (error) {
    if (error instanceof CommanderError) {
      return error.exitCode;
    }
    throw error;
  }
}
