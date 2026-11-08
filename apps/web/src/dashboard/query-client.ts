import { QueryClient } from "@tanstack/react-query";
import { ApiFailure } from "./api.ts";

/** Retries once, except answers that cannot change by retrying: missing, refused or signed out. */
export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        retry: (failures, error) =>
          failures < 1 && !(error instanceof ApiFailure && FINAL.has(error.code)),
      },
      mutations: { retry: false },
    },
  });
}

const FINAL = new Set(["not_found", "forbidden", "unauthenticated", "invalid_input"]);
