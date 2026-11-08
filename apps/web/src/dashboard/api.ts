// Same-origin calls from the dashboard to /api/v1 and the session endpoints under /api/auth.
// The browser sends the session cookie, fetch metadata and the Origin header, which the Worker
// checks (apps/app/src/api/access.ts). Every response is validated with the shared contracts.
import {
  ApiError,
  ArtifactList,
  ArtifactSummary,
  type ErrorCode,
  LifecycleResult,
} from "@portifact/contracts";
import { z } from "zod";

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** Why a call failed: a documented API error code, no network, or an answer we do not know. */
export type FailureCode = ErrorCode | "network" | "unexpected";

export class ApiFailure extends Error {
  constructor(
    readonly code: FailureCode,
    readonly status: number,
  ) {
    super(code);
    this.name = "ApiFailure";
  }
}

export type LifecycleAction = "renew" | "archive" | "restore" | "delete";

export interface Account {
  email: string;
  name: string;
}

export interface DashboardApi {
  /** The signed-in account, or null without a session. */
  account(): Promise<Account | null>;
  signOut(): Promise<void>;
  listArtifacts(cursor?: string): Promise<ArtifactList>;
  getArtifact(artifactId: string): Promise<ArtifactSummary>;
  lifecycle(artifactId: string, action: LifecycleAction): Promise<LifecycleResult>;
}

const SessionBody = z.object({
  user: z.object({ email: z.string(), name: z.string().nullish() }),
});

export interface DashboardApiOptions {
  fetch: FetchLike;
  /** Called when the session is gone, so the page can send the user to sign in. */
  onUnauthenticated(): void;
}

export function dashboardApi({ fetch, onUnauthenticated }: DashboardApiOptions): DashboardApi {
  const call = async <T>(
    path: string,
    schema: z.ZodType<T>,
    method: "GET" | "POST" | "DELETE" = "GET",
  ): Promise<T> => {
    let response: Response;
    try {
      response = await fetch(path, {
        method,
        credentials: "same-origin",
        headers: { accept: "application/json" },
      });
    } catch {
      throw new ApiFailure("network", 0);
    }
    const body = await response.json().catch(() => null);
    if (response.ok) {
      const parsed = schema.safeParse(body);
      if (parsed.success) return parsed.data;
      throw new ApiFailure("unexpected", response.status);
    }
    if (response.status === 401) {
      onUnauthenticated();
      throw new ApiFailure("unauthenticated", 401);
    }
    const error = ApiError.safeParse(body);
    throw new ApiFailure(error.success ? error.data.error.code : "unexpected", response.status);
  };

  return {
    async account() {
      const session = await call("/api/auth/get-session", SessionBody.nullable());
      return session ? { email: session.user.email, name: session.user.name ?? "" } : null;
    },
    async signOut() {
      let response: Response;
      try {
        response = await fetch("/api/auth/sign-out", {
          method: "POST",
          credentials: "same-origin",
          headers: { accept: "application/json", "content-type": "application/json" },
          body: "{}",
        });
      } catch {
        throw new ApiFailure("network", 0);
      }
      if (!response.ok) throw new ApiFailure("unexpected", response.status);
    },
    listArtifacts(cursor) {
      const query = cursor ? `?${new URLSearchParams({ cursor })}` : "";
      return call(`/api/v1/artifacts${query}`, ArtifactList);
    },
    getArtifact(artifactId) {
      return call(`/api/v1/artifacts/${encodeURIComponent(artifactId)}`, ArtifactSummary);
    },
    lifecycle(artifactId, action) {
      const base = `/api/v1/artifacts/${encodeURIComponent(artifactId)}`;
      return action === "delete"
        ? call(base, LifecycleResult, "DELETE")
        : call(`${base}/${action}`, LifecycleResult, "POST");
    },
  };
}
