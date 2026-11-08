import { run } from "./cli.ts";

const io = {
  stdout: (text: string) => process.stdout.write(text),
  stderr: (text: string) => process.stderr.write(text),
};

try {
  process.exitCode = await run(process.argv.slice(2), io);
} catch (error) {
  // Only the message: a stack or a raw cause could carry request details.
  io.stderr(`Error: ${error instanceof Error ? error.message : "unexpected failure"}\n`);
  process.exitCode = 1;
}
