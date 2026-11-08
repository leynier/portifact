// Compiles the CLI into standalone executables and packages them for release.
//
//   bun scripts/build-cli.ts            build for the current platform only
//   bun scripts/build-cli.ts --all      build every supported platform
//   bun scripts/build-cli.ts --targets linux-x64,darwin-arm64
//
// Output goes to dist/release: one archive per platform plus SHA256SUMS.
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { $ } from "bun";

interface Target {
  name: string;
  bunTarget: string;
  windows: boolean;
}

const TARGETS: Target[] = [
  { name: "linux-x64", bunTarget: "bun-linux-x64", windows: false },
  { name: "linux-arm64", bunTarget: "bun-linux-arm64", windows: false },
  { name: "linux-x64-musl", bunTarget: "bun-linux-x64-musl", windows: false },
  { name: "linux-arm64-musl", bunTarget: "bun-linux-arm64-musl", windows: false },
  { name: "darwin-x64", bunTarget: "bun-darwin-x64", windows: false },
  { name: "darwin-arm64", bunTarget: "bun-darwin-arm64", windows: false },
  { name: "windows-x64", bunTarget: "bun-windows-x64", windows: true },
  { name: "windows-arm64", bunTarget: "bun-windows-arm64", windows: true },
];

const root = join(import.meta.dir, "..");
const entry = join(root, "packages/cli/src/main.ts");
const outDir = join(root, "dist/release");
const stagingDir = join(root, "dist/staging");

function nativeTargetName(): string {
  const os = process.platform === "win32" ? "windows" : process.platform;
  return `${os}-${process.arch}`;
}

function selectTargets(args: string[]): Target[] {
  if (args.includes("--all")) return TARGETS;
  const flagIndex = args.indexOf("--targets");
  const names = flagIndex >= 0 ? (args[flagIndex + 1] ?? "").split(",") : [nativeTargetName()];
  return names.map((name) => {
    const target = TARGETS.find((candidate) => candidate.name === name);
    if (!target)
      throw new Error(`Unknown target "${name}". Known: ${TARGETS.map((t) => t.name).join(", ")}`);
    return target;
  });
}

async function sha256(path: string): Promise<string> {
  const hasher = new Bun.CryptoHasher("sha256");
  for await (const chunk of Bun.file(path).stream()) hasher.update(chunk);
  return hasher.digest("hex");
}

async function build(target: Target): Promise<string> {
  const binary = target.windows ? "portifact.exe" : "portifact";
  const staging = join(stagingDir, target.name);
  await mkdir(staging, { recursive: true });
  await $`bun build ${entry} --compile --minify --target=${target.bunTarget} --outfile ${join(staging, binary)}`.quiet();

  const archive = `portifact-${target.name}.${target.windows ? "zip" : "tar.gz"}`;
  const archivePath = join(outDir, archive);
  if (target.windows) {
    await $`zip -q -j ${archivePath} ${join(staging, binary)}`;
  } else {
    await $`tar -C ${staging} -czf ${archivePath} ${binary}`;
  }
  console.log(`built ${archive}`);
  return archive;
}

const targets = selectTargets(process.argv.slice(2));
await rm(outDir, { recursive: true, force: true });
await rm(stagingDir, { recursive: true, force: true });
await mkdir(outDir, { recursive: true });

const archives: string[] = [];
for (const target of targets) archives.push(await build(target));

const sums = await Promise.all(
  archives.map(async (archive) => `${await sha256(join(outDir, archive))}  ${archive}`),
);
await Bun.write(join(outDir, "SHA256SUMS"), `${sums.join("\n")}\n`);
await rm(stagingDir, { recursive: true, force: true });
console.log(`wrote ${join("dist/release", "SHA256SUMS")}`);
