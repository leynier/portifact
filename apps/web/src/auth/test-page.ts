// Test support for the auth pages: loads a real page's markup into the test document and
// fakes the same-origin auth API. Only used by tests.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Api, ApiResponse, PageLocation } from "./api.ts";
import type { PageEnv } from "./login.ts";

export const ORIGIN = "https://app.portifact.com";

export function loadPage(name: "login" | "device" | "consent"): void {
  // Vitest runs from apps/web; happy-dom replaces URL, so build the path from the root.
  const html = readFileSync(join(process.cwd(), `${name}.html`), "utf8");
  const body = /<body[^>]*>([\s\S]*)<\/body>/.exec(html)?.[1] ?? "";
  document.body.innerHTML = body;
}

export type Handler = (body: unknown) => ApiResponse | Promise<ApiResponse>;

export interface FakeApi extends Api {
  calls: { method: string; path: string; body?: unknown }[];
  on(method: "GET" | "POST", path: string, handler: Handler | ApiResponse): void;
}

/** Answers like the auth API; unscripted calls answer 404. */
export function fakeApi(): FakeApi {
  const handlers = new Map<string, Handler>();
  const calls: FakeApi["calls"] = [];
  const answer = async (method: string, path: string, body?: unknown) => {
    calls.push(body === undefined ? { method, path } : { method, path, body });
    const handler = handlers.get(`${method} ${path}`);
    return handler ? handler(body) : { status: 404, body: null };
  };
  return {
    calls,
    on(method, path, handler) {
      handlers.set(`${method} ${path}`, typeof handler === "function" ? handler : () => handler);
    },
    get: (path) => answer("GET", path),
    post: (path, body) => answer("POST", path, body),
  };
}

export interface FakeLocation extends PageLocation {
  assigned: string[];
}

export function fakeLocation(search = ""): FakeLocation {
  const assigned: string[] = [];
  return { search, assigned, assign: (url) => assigned.push(url) };
}

export function pageEnv(api: FakeApi, location: FakeLocation): PageEnv {
  return { api, location, origin: ORIGIN };
}

export function element<T extends HTMLElement = HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (!found) throw new Error(`#${id} not rendered`);
  return found as T;
}

/** Lets pending promise callbacks run, as a browser does between events. */
export async function settle(): Promise<void> {
  for (let index = 0; index < 10; index += 1) await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

export function submit(form: HTMLFormElement): void {
  form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
}

export const session = (email: string): ApiResponse => ({
  status: 200,
  body: { user: { email }, session: { id: "s" } },
});
