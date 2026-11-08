import { chmod, mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";
import type { Runtime, SecretsApi } from "./runtime.ts";

/** Tokens for one server. Never printed, logged or included in JSON output. */
export const Credentials = z.object({
  accessToken: z.string().min(1),
  refreshToken: z.string().min(1).optional(),
  /** Epoch milliseconds after which the access token is no longer valid. */
  expiresAt: z.number(),
  scopes: z.array(z.string()),
});
export type Credentials = z.infer<typeof Credentials>;

export type StoreKind = "keyring" | "file";

/** Credentials are kept per server origin, so a staging login never replaces production. */
export interface CredentialStore {
  readonly kind: StoreKind;
  /** The fallback file, which every store also reads and cleans. */
  readonly filePath: string;
  load(origin: string): Promise<Credentials | undefined>;
  save(origin: string, credentials: Credentials): Promise<void>;
  /** Returns true when something was removed. */
  remove(origin: string): Promise<boolean>;
}

export const KEYRING_SERVICE = "portifact";
export const CREDENTIALS_FILE = "credentials.json";
const PROBE_NAME = "portifact-cli-probe";

/**
 * Uses the OS credential store when it works and a 0600 file otherwise (plan section 5). The
 * file is still read and cleaned when the keyring works, so credentials saved during an earlier
 * fallback are found and do not linger after logout.
 */
export async function openCredentialStore(runtime: Runtime): Promise<CredentialStore> {
  const file = new FileStore(join(runtime.configDir, CREDENTIALS_FILE));
  const keyring =
    runtime.secrets && (await keyringWorks(runtime.secrets))
      ? new KeyringStore(runtime.secrets)
      : undefined;

  return {
    kind: keyring ? "keyring" : "file",
    filePath: file.path,
    async load(origin) {
      return (await keyring?.load(origin)) ?? (await file.load(origin));
    },
    async save(origin, credentials) {
      if (!keyring) return file.save(origin, credentials);
      await keyring.save(origin, credentials);
      await file.remove(origin);
    },
    async remove(origin) {
      const fromKeyring = (await keyring?.remove(origin)) ?? false;
      const fromFile = await file.remove(origin);
      return fromKeyring || fromFile;
    },
  };
}

// Bun.secrets throws when the platform has no usable store, for example Linux without a
// running Secret Service.
async function keyringWorks(secrets: SecretsApi): Promise<boolean> {
  try {
    await secrets.get({ service: KEYRING_SERVICE, name: PROBE_NAME });
    return true;
  } catch {
    return false;
  }
}

class KeyringStore {
  constructor(private readonly secrets: SecretsApi) {}

  async load(origin: string): Promise<Credentials | undefined> {
    const value = await this.secrets.get({ service: KEYRING_SERVICE, name: origin });
    return value === null ? undefined : parseCredentials(value);
  }

  save(origin: string, credentials: Credentials): Promise<void> {
    return this.secrets.set({
      service: KEYRING_SERVICE,
      name: origin,
      value: JSON.stringify(credentials),
    });
  }

  remove(origin: string): Promise<boolean> {
    return this.secrets.delete({ service: KEYRING_SERVICE, name: origin });
  }
}

const CredentialsFile = z.object({
  version: z.literal(1),
  credentials: z.record(z.string(), z.unknown()),
});

const PRIVATE_FILE = 0o600;
const PRIVATE_DIR = 0o700;

export class FileStore {
  constructor(readonly path: string) {}

  async load(origin: string): Promise<Credentials | undefined> {
    const entries = await this.read();
    const entry = entries[origin];
    if (entry === undefined) return undefined;
    await this.tightenPermissions();
    const parsed = Credentials.safeParse(entry);
    return parsed.success ? parsed.data : undefined;
  }

  async save(origin: string, credentials: Credentials): Promise<void> {
    const entries = await this.read();
    entries[origin] = credentials;
    await this.write(entries);
  }

  async remove(origin: string): Promise<boolean> {
    const entries = await this.read();
    if (!(origin in entries)) return false;
    delete entries[origin];
    if (Object.keys(entries).length === 0) {
      await unlink(this.path);
    } else {
      await this.write(entries);
    }
    return true;
  }

  // A missing or unreadable file holds nothing; the next save replaces it.
  private async read(): Promise<Record<string, unknown>> {
    let text: string;
    try {
      text = await readFile(this.path, "utf8");
    } catch (error) {
      if (isNotFound(error)) return {};
      throw error;
    }
    try {
      const parsed = CredentialsFile.safeParse(JSON.parse(text));
      return parsed.success ? { ...parsed.data.credentials } : {};
    } catch {
      return {};
    }
  }

  // Written to a private temporary file and renamed, so the tokens are never readable by
  // others, not even for a moment, and a crash cannot leave a half-written file.
  private async write(entries: Record<string, unknown>): Promise<void> {
    const dir = dirname(this.path);
    await mkdir(dir, { recursive: true, mode: PRIVATE_DIR });
    const temporary = `${this.path}.${process.pid}.${Date.now()}.tmp`;
    const body = `${JSON.stringify({ version: 1, credentials: entries }, null, 2)}\n`;
    await writeFile(temporary, body, { mode: PRIVATE_FILE, flag: "wx" });
    await rename(temporary, this.path);
    await chmod(this.path, PRIVATE_FILE);
  }

  // A file copied or restored with wider permissions is closed again before use.
  private async tightenPermissions(): Promise<void> {
    if (process.platform === "win32") return;
    const { mode } = await stat(this.path);
    if ((mode & 0o077) !== 0) await chmod(this.path, PRIVATE_FILE);
  }
}

function parseCredentials(value: string): Credentials | undefined {
  try {
    const parsed = Credentials.safeParse(JSON.parse(value));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

function isNotFound(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
