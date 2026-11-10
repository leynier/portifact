import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { APP_HOST, CONTENT_SITE, CUSTOMER_SITE, SITE_HOST } from "./hosts.ts";
import { TURNSTILE_HOST } from "./turnstile-fake.ts";

export interface TlsMaterial {
  key: string;
  cert: string;
}

let cached: TlsMaterial | undefined;

// A throwaway self-signed certificate. Browsers run with ignoreHTTPSErrors, so it only needs
// to exist; nothing is written outside a temporary directory that is removed right away.
export function selfSignedCertificate(): TlsMaterial {
  if (cached) return cached;
  const dir = mkdtempSync(join(tmpdir(), "pf-e2e-"));
  const keyPath = join(dir, "key.pem");
  const certPath = join(dir, "cert.pem");
  try {
    execFileSync(
      "openssl",
      [
        "req",
        "-x509",
        "-newkey",
        "ec",
        "-pkeyopt",
        "ec_paramgen_curve:prime256v1",
        "-nodes",
        "-keyout",
        keyPath,
        "-out",
        certPath,
        "-days",
        "2",
        "-subj",
        "/CN=portifact e2e",
        "-addext",
        `subjectAltName=DNS:${APP_HOST},DNS:${SITE_HOST},DNS:*.${CONTENT_SITE},DNS:*.${CUSTOMER_SITE},DNS:${TURNSTILE_HOST}`,
      ],
      { stdio: "ignore" },
    );
    cached = { key: readFileSync(keyPath, "utf8"), cert: readFileSync(certPath, "utf8") };
    return cached;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
