// Renders every email with sample values to a folder for review in a browser or a mail client:
// `bun run --cwd packages/emails preview [folder]` (default /tmp/portifact-email-previews). Each
// email gets an .html and a .txt file. The values are samples, never real codes or addresses.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { previews } from "../src/previews.ts";

const folder = process.argv[2] ?? "/tmp/portifact-email-previews";
mkdirSync(folder, { recursive: true });
for (const { name, email } of previews()) {
  writeFileSync(join(folder, `${name}.html`), email.html);
  writeFileSync(join(folder, `${name}.txt`), `Subject: ${email.subject}\n\n${email.text}\n`);
  console.log(`${join(folder, name)}.html`);
}
