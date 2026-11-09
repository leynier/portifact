// Same-origin calls from the auth pages to Better Auth under /api/auth. The browser sends the
// session cookie and the Origin header, which the Worker checks on every mutation, and the
// page's language, which the Worker writes its emails in.

export interface ApiResponse {
  status: number;
  body: unknown;
}

export interface Api {
  get(path: string): Promise<ApiResponse>;
  post(path: string, body: unknown): Promise<ApiResponse>;
}

/** What the pages need from `window.location`, so tests can observe navigation. */
export interface PageLocation {
  readonly search: string;
  assign(url: string): void;
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface BrowserApiOptions {
  /**
   * The page's language, sent as `Accept-Language` on every call so the Worker writes what it
   * sends (the sign-in code email) in the language the reader sees.
   */
  locale?: string;
}

export function browserApi(fetchImpl: FetchLike, options: BrowserApiOptions = {}): Api {
  const headers: Record<string, string> = {
    accept: "application/json",
    "content-type": "application/json",
  };
  if (options.locale) headers["accept-language"] = options.locale;
  const call = async (path: string, init: RequestInit): Promise<ApiResponse> => {
    try {
      const response = await fetchImpl(`/api/auth${path}`, {
        credentials: "same-origin",
        headers,
        ...init,
      });
      const text = await response.text();
      return { status: response.status, body: parse(text) };
    } catch {
      // Offline or blocked: report it like a server error so the page shows a retry message.
      return { status: 0, body: null };
    }
  };
  return {
    get: (path) => call(path, { method: "GET" }),
    post: (path, body) => call(path, { method: "POST", body: JSON.stringify(body) }),
  };
}

function parse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** Reads a string property from an unknown JSON body. */
export function field(body: unknown, name: string): string | undefined {
  if (typeof body !== "object" || body === null) return undefined;
  const value = (body as Record<string, unknown>)[name];
  return typeof value === "string" ? value : undefined;
}

export interface CurrentUser {
  email: string;
  /** The version of the terms the account accepted, if any. */
  termsVersion: string | undefined;
}

/** The signed-in user, or undefined when there is no session. */
export async function currentUser(api: Api): Promise<CurrentUser | undefined> {
  const response = await api.get("/get-session");
  if (response.status !== 200) return undefined;
  const user =
    typeof response.body === "object" && response.body !== null
      ? (response.body as Record<string, unknown>).user
      : undefined;
  const email = field(user, "email");
  return email ? { email, termsVersion: field(user, "termsVersion") } : undefined;
}

/** The signed-in user's email, or undefined when there is no session. */
export async function currentUserEmail(api: Api): Promise<string | undefined> {
  return (await currentUser(api))?.email;
}
