import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CREDENTIALS_FILE,
  type Credentials,
  FileStore,
  KEYRING_SERVICE,
  openCredentialStore,
} from "./credentials.ts";
import { defaultRuntime } from "./runtime.ts";
import { FakeSecrets } from "./testing/harness.ts";

const PROD = "https://app.portifact.com";
const STAGING = "https://staging.portifact.example";
const sample: Credentials = {
  accessToken: "access",
  refreshToken: "refresh",
  expiresAt: 1,
  scopes: ["artifacts:read"],
};

let dir: string;
const posix = process.platform !== "win32";

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "portifact-store-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function open(secrets: FakeSecrets | undefined) {
  return openCredentialStore({ ...defaultRuntime(), secrets, configDir: dir });
}

describe("file credential store", () => {
  it("keeps credentials per server origin", async () => {
    const store = new FileStore(join(dir, "nested", CREDENTIALS_FILE));
    await store.save(PROD, sample);
    await store.save(STAGING, { ...sample, accessToken: "staging" });

    expect(await store.load(PROD)).toEqual(sample);
    expect((await store.load(STAGING))?.accessToken).toBe("staging");

    expect(await store.remove(PROD)).toBe(true);
    expect(await store.load(PROD)).toBeUndefined();
    expect(await store.load(STAGING)).toBeDefined();
    expect(await store.remove(PROD)).toBe(false);
  });

  it("deletes the file when the last credentials are removed", async () => {
    const path = join(dir, CREDENTIALS_FILE);
    const store = new FileStore(path);
    await store.save(PROD, sample);
    await store.remove(PROD);
    await expect(stat(path)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.runIf(posix)("writes the file 0600 and its directory 0700", async () => {
    const path = join(dir, "config", CREDENTIALS_FILE);
    await new FileStore(path).save(PROD, sample);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect((await stat(join(dir, "config"))).mode & 0o777).toBe(0o700);
  });

  it.runIf(posix)("restores 0600 when the file was rewritten with wider permissions", async () => {
    const path = join(dir, CREDENTIALS_FILE);
    const store = new FileStore(path);
    await store.save(PROD, sample);
    await chmod(path, 0o644);

    expect(await store.load(PROD)).toEqual(sample);
    expect((await stat(path)).mode & 0o777).toBe(0o600);

    await chmod(path, 0o644);
    await store.save(STAGING, sample);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });

  it("treats a corrupt or foreign file as empty and replaces it on save", async () => {
    const path = join(dir, CREDENTIALS_FILE);
    const store = new FileStore(path);
    for (const content of ["not json", '{"version":2,"credentials":{}}']) {
      await writeFile(path, content);
      expect(await store.load(PROD)).toBeUndefined();
    }
    await store.save(PROD, sample);
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({
      version: 1,
      credentials: { [PROD]: sample },
    });
  });

  it("ignores an entry that is not valid credentials", async () => {
    const path = join(dir, CREDENTIALS_FILE);
    await writeFile(path, JSON.stringify({ version: 1, credentials: { [PROD]: { a: 1 } } }));
    expect(await new FileStore(path).load(PROD)).toBeUndefined();
  });

  it("reports read errors other than a missing file", async () => {
    const path = join(dir, CREDENTIALS_FILE);
    await mkdir(path);
    await expect(new FileStore(path).load(PROD)).rejects.toMatchObject({ code: "EISDIR" });
  });
});

describe("credential store selection", () => {
  it("uses the OS credential store when it works", async () => {
    const secrets = new FakeSecrets();
    const store = await open(secrets);
    expect(store.kind).toBe("keyring");

    await store.save(PROD, sample);
    expect(JSON.parse(secrets.entries.get(`${KEYRING_SERVICE}\u0000${PROD}`) ?? "")).toEqual(
      sample,
    );
    await expect(stat(join(dir, CREDENTIALS_FILE))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await store.load(PROD)).toEqual(sample);
    expect(await store.remove(PROD)).toBe(true);
    expect(secrets.entries.size).toBe(0);
    expect(await store.remove(PROD)).toBe(false);
  });

  it("falls back to the file when there is no store or it fails", async () => {
    for (const secrets of [undefined, new FakeSecrets(false)]) {
      const store = await open(secrets);
      expect(store.kind).toBe("file");
      expect(store.filePath).toBe(join(dir, CREDENTIALS_FILE));
      await store.save(PROD, sample);
      expect(await store.load(PROD)).toEqual(sample);
      expect(await store.remove(PROD)).toBe(true);
    }
  });

  it("finds credentials from an earlier fallback, and moves them to the keyring on save", async () => {
    await new FileStore(join(dir, CREDENTIALS_FILE)).save(PROD, sample);
    const secrets = new FakeSecrets();
    const store = await open(secrets);

    expect(await store.load(PROD)).toEqual(sample);
    await store.save(PROD, { ...sample, accessToken: "rotated" });
    await expect(stat(join(dir, CREDENTIALS_FILE))).rejects.toMatchObject({ code: "ENOENT" });
    expect((await store.load(PROD))?.accessToken).toBe("rotated");
  });

  it("removes credentials from an earlier fallback on logout", async () => {
    await new FileStore(join(dir, CREDENTIALS_FILE)).save(PROD, sample);
    const store = await open(new FakeSecrets());
    expect(await store.remove(PROD)).toBe(true);
    expect(await store.load(PROD)).toBeUndefined();
  });

  it("ignores a keyring entry that is not valid credentials", async () => {
    const secrets = new FakeSecrets();
    const store = await open(secrets);
    for (const value of ["not json", '{"accessToken":""}']) {
      secrets.entries.set(`${KEYRING_SERVICE}\u0000${PROD}`, value);
      expect(await store.load(PROD)).toBeUndefined();
    }
  });
});
