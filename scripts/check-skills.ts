// Validates the agent skills in skills/ against the Agent Skills format used by `npx skills`.
// Runs as part of `bun run check`.
import { readdir } from "node:fs/promises";
import { join } from "node:path";

const NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const skillsDir = join(import.meta.dir, "..", "skills");

function frontmatter(text: string): Record<string, unknown> | undefined {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(text);
  if (!match?.[1]) return undefined;
  const parsed: unknown = Bun.YAML.parse(match[1]);
  return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : undefined;
}

const errors: string[] = [];
const entries = await readdir(skillsDir, { withFileTypes: true });
const skillDirs = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
if (skillDirs.length === 0) errors.push("skills/ has no skill directories");

for (const dir of skillDirs) {
  const file = Bun.file(join(skillsDir, dir, "SKILL.md"));
  if (!(await file.exists())) {
    errors.push(`skills/${dir}: missing SKILL.md`);
    continue;
  }
  const meta = frontmatter(await file.text());
  if (!meta) {
    errors.push(`skills/${dir}/SKILL.md: missing YAML frontmatter`);
    continue;
  }
  const { name, description } = meta;
  if (typeof name !== "string" || !NAME.test(name) || name.length > 64) {
    errors.push(
      `skills/${dir}: name must be lowercase words joined by hyphens, at most 64 characters`,
    );
  } else if (name !== dir) {
    errors.push(`skills/${dir}: name "${name}" must match the directory name`);
  }
  if (typeof description !== "string" || description.trim() === "" || description.length > 1024) {
    errors.push(`skills/${dir}: description must be a non-empty string of at most 1024 characters`);
  }
}

if (errors.length > 0) {
  console.error(errors.join("\n"));
  process.exit(1);
}
console.log(`skills ok: ${skillDirs.join(", ")}`);
