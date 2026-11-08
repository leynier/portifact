// A local HTTP server that behaves like app.portifact.com for the CLI's requests: the device
// code endpoint, device and refresh grants, revocation and GET /api/v1/me. The token endpoint's
// answers to device polls are scripted, so each test chooses the sequence it needs.
import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export type PollOutcome =
  | "pending"
  | "slow_down"
  | "approve"
  | "denied"
  | "expired"
  | "server_error"
  | "invalid_client";

export interface RecordedRequest {
  method: string;
  path: string;
  form: Record<string, string>;
  authorization: string | undefined;
}

interface AccessToken {
  userId: string;
  scopes: string[];
  revoked: boolean;
}

export interface FakeServer {
  origin: string;
  requests: RecordedRequest[];
  /** Answers to the next device polls, in order. When empty, polls stay pending. */
  pollOutcomes: PollOutcome[];
  /** Overrides the device code response fields, or replaces the response with a status. */
  device: {
    interval?: number | undefined;
    expiresIn: number;
    verificationUri?: string;
    verificationUriComplete?: string | null;
    status?: number;
    /** A raw body to answer with instead of a device authorization. */
    body?: string;
  };
  userId: string;
  /** Status for every revocation request, 200 by default. */
  revokeStatus: number;
  /** Status for the next refresh requests that should fail before reaching token logic. */
  refreshStatus?: number;
  /** Whether refresh responses include a rotated refresh token. */
  rotateRefreshTokens: boolean;
  /** Tokens the server issued, to check they never appear in output. */
  issuedTokens: string[];
  accessTokens: Map<string, AccessToken>;
  refreshTokens: Map<string, { userId: string; scopes: string[] }>;
  /** Issues a token pair directly, as if a login had happened before the test. */
  issue(scopes?: string[]): { accessToken: string; refreshToken: string };
  revokedTokens(): string[];
  close(): Promise<void>;
}

const DEVICE_CODE = "device-code-not-for-display";
export const USER_CODE = "WDJBMJHT";

export async function startFakeServer(): Promise<FakeServer> {
  const revoked = new Set<string>();
  const fake: Omit<FakeServer, "origin" | "close"> = {
    requests: [],
    pollOutcomes: [],
    device: { interval: 5, expiresIn: 600 },
    userId: "user-123",
    revokeStatus: 200,
    rotateRefreshTokens: true,
    issuedTokens: [],
    accessTokens: new Map(),
    refreshTokens: new Map(),
    issue(scopes = ["artifacts:read", "offline_access"]) {
      const accessToken = `at-${randomUUID()}`;
      const refreshToken = `rt-${randomUUID()}`;
      fake.issuedTokens.push(accessToken, refreshToken);
      fake.accessTokens.set(accessToken, { userId: fake.userId, scopes, revoked: false });
      fake.refreshTokens.set(refreshToken, { userId: fake.userId, scopes });
      return { accessToken, refreshToken };
    },
    revokedTokens: () => [...revoked],
  };

  let origin = "";
  const http = createServer((request, response) => {
    void handle(request, response).catch(() => {
      response.statusCode = 500;
      response.end();
    });
  });

  async function handle(request: IncomingMessage, response: ServerResponse) {
    const url = new URL(request.url ?? "/", origin);
    const body = await readBody(request);
    const form = Object.fromEntries(new URLSearchParams(body));
    fake.requests.push({
      method: request.method ?? "GET",
      path: url.pathname,
      form,
      authorization: request.headers.authorization,
    });

    const route = `${request.method} ${url.pathname}`;
    if (route === "POST /api/auth/device/code") return deviceCode(response);
    if (route === "POST /api/auth/oauth2/token") return token(form, response);
    if (route === "POST /api/auth/oauth2/revoke") {
      if (fake.revokeStatus === 200) revoke(form.token ?? "");
      return send(response, fake.revokeStatus, {});
    }
    if (route === "GET /api/v1/me") return me(request.headers.authorization, response);
    return send(response, 404, { error: { code: "not_found", message: "Not found." } });
  }

  function deviceCode(response: ServerResponse) {
    if (fake.device.status) {
      return send(response, fake.device.status, { error: "invalid_client" });
    }
    if (fake.device.body !== undefined) {
      response.writeHead(200, { "content-type": "application/json" });
      return response.end(fake.device.body);
    }
    const verificationUri = fake.device.verificationUri ?? `${origin}/device`;
    const complete =
      fake.device.verificationUriComplete === null
        ? {}
        : {
            verification_uri_complete:
              fake.device.verificationUriComplete ?? `${verificationUri}?user_code=${USER_CODE}`,
          };
    return send(response, 200, {
      device_code: DEVICE_CODE,
      user_code: USER_CODE,
      verification_uri: verificationUri,
      ...complete,
      expires_in: fake.device.expiresIn,
      ...(fake.device.interval === undefined ? {} : { interval: fake.device.interval }),
    });
  }

  function token(form: Record<string, string>, response: ServerResponse) {
    if (form.grant_type === "urn:ietf:params:oauth:grant-type:device_code") {
      if (form.device_code !== DEVICE_CODE || form.client_id !== "portifact-cli") {
        return send(response, 400, { error: "invalid_grant" });
      }
      const outcome = fake.pollOutcomes.shift() ?? "pending";
      switch (outcome) {
        case "approve": {
          const scopes = scopesFrom(lastDeviceScope());
          return send(response, 200, tokenResponse(fake.issue(scopes), scopes));
        }
        case "pending":
          return send(response, 400, { error: "authorization_pending" });
        case "slow_down":
          return send(response, 400, { error: "slow_down" });
        case "denied":
          return send(response, 400, { error: "access_denied" });
        case "expired":
          return send(response, 400, { error: "expired_token" });
        case "server_error":
          return send(response, 503, {});
        case "invalid_client":
          return send(response, 401, { error: "invalid_client" });
      }
    }
    if (form.grant_type === "refresh_token") {
      if (fake.refreshStatus) return send(response, fake.refreshStatus, {});
      const current = fake.refreshTokens.get(form.refresh_token ?? "");
      if (!current || form.client_id !== "portifact-cli") {
        return send(response, 400, { error: "invalid_grant" });
      }
      const pair = fake.issue(current.scopes);
      if (fake.rotateRefreshTokens) {
        fake.refreshTokens.delete(form.refresh_token ?? "");
        return send(response, 200, tokenResponse(pair, current.scopes));
      }
      fake.refreshTokens.delete(pair.refreshToken);
      const { refresh_token: _, ...rest } = tokenResponse(pair, current.scopes);
      return send(response, 200, rest);
    }
    return send(response, 400, { error: "unsupported_grant_type" });
  }

  function lastDeviceScope(): string {
    const request = fake.requests.findLast((r) => r.path === "/api/auth/device/code");
    return request?.form.scope ?? "";
  }

  function revoke(value: string) {
    revoked.add(value);
    fake.refreshTokens.delete(value);
    const access = fake.accessTokens.get(value);
    if (access) access.revoked = true;
  }

  function me(authorization: string | undefined, response: ServerResponse) {
    const value = authorization?.startsWith("Bearer ") ? authorization.slice(7) : "";
    const access = fake.accessTokens.get(value);
    if (!access || access.revoked) return send(response, 401, { error: "invalid_token" });
    return send(response, 200, {
      userId: access.userId,
      clientId: "portifact-cli",
      scopes: access.scopes,
    });
  }

  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;

  return Object.assign(fake, {
    origin,
    close: () =>
      new Promise<void>((resolve, reject) =>
        http.close((error) => (error ? reject(error) : resolve())),
      ),
  });
}

function tokenResponse(
  pair: { accessToken: string; refreshToken: string },
  scopes?: string[],
): Record<string, unknown> {
  return {
    access_token: pair.accessToken,
    refresh_token: pair.refreshToken,
    token_type: "Bearer",
    expires_in: 3600,
    ...(scopes ? { scope: scopes.join(" ") } : {}),
  };
}

function scopesFrom(scope: string): string[] {
  return scope.split(" ").filter(Boolean);
}

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => {
      body += chunk;
    });
    request.on("end", () => resolve(body));
    request.on("error", reject);
  });
}

function send(response: ServerResponse, status: number, body: unknown) {
  response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  response.end(JSON.stringify(body));
}
