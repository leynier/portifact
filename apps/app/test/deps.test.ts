import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createClientMetadataFetch, type FetchLike, workerDeps } from "../src/auth/deps.ts";
import {
  cloudflareEmailSender,
  RecipientSuppressedError,
  SENDER,
  signInCodeEmail,
} from "../src/auth/email.ts";
import { bearerToken } from "../src/auth/introspection.ts";

function recordingFetch(response: Response) {
  const calls: { url: string; redirect: RequestInit["redirect"] }[] = [];
  const fetchImpl: FetchLike = async (input, init) => {
    calls.push({ url: input.toString(), redirect: init?.redirect });
    return response;
  };
  return { calls, fetchImpl };
}

/** A stand-in for the send_email binding that records what it was asked to send. */
function fakeEmailBinding(fail: boolean | (() => unknown) = false) {
  const sent: unknown[] = [];
  const binding = {
    send: async (message: unknown) => {
      if (typeof fail === "function") throw fail();
      if (fail) throw new Error(`rejected: ${JSON.stringify(message)}`);
      sent.push(message);
      return { messageId: "m-1" };
    },
  } as unknown as SendEmail;
  return { sent, binding };
}

describe("client metadata fetch transport", () => {
  it("fetches https documents without following redirects", async () => {
    const { calls, fetchImpl } = recordingFetch(Response.json({ client_id: "x" }));
    const fetchMetadata = createClientMetadataFetch(fetchImpl);
    const response = await fetchMetadata(new Request("https://client.example/metadata.json"));
    expect(response.status).toBe(200);
    expect(calls).toEqual([{ url: "https://client.example/metadata.json", redirect: "manual" }]);
  });

  it("refuses plain http URLs before any request is made", async () => {
    const { calls, fetchImpl } = recordingFetch(new Response("{}"));
    const fetchMetadata = createClientMetadataFetch(fetchImpl);
    await expect(fetchMetadata("http://client.example/metadata.json")).rejects.toThrow("https");
    expect(calls).toHaveLength(0);
  });

  it("passes 304 Not Modified through, so a cached document can be revalidated", async () => {
    // chatgpt.com serves Codex's document with an ETag and answers the plugin's
    // If-None-Match with 304, which is not a redirect.
    const notModified = new Response(null, { status: 304, headers: { etag: 'W/"1cd"' } });
    const fetchMetadata = createClientMetadataFetch(recordingFetch(notModified).fetchImpl);
    const response = await fetchMetadata(new URL("https://client.example/metadata.json"), {
      headers: { "if-none-match": 'W/"1cd"' },
    });
    expect(response.status).toBe(304);
  });

  it.each([300, 301, 302, 303, 305, 307, 308])("fails on a %i redirect status", async (status) => {
    const redirect = new Response(null, {
      status,
      headers: { location: "https://elsewhere.example/" },
    });
    const fetchMetadata = createClientMetadataFetch(recordingFetch(redirect).fetchImpl);
    await expect(fetchMetadata(new URL("https://client.example/metadata.json"))).rejects.toThrow(
      "redirects",
    );
  });

  it("fails on a redirect instead of trusting another location", async () => {
    const redirect = new Response(null, {
      status: 302,
      headers: { location: "https://elsewhere.example/" },
    });
    const fetchMetadata = createClientMetadataFetch(recordingFetch(redirect).fetchImpl);
    await expect(fetchMetadata(new URL("https://client.example/metadata.json"))).rejects.toThrow(
      "redirects",
    );
  });
});

describe("worker dependencies", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("fetches client metadata through the guarded transport", async () => {
    await expect(
      workerDeps(env).fetchClientMetadata("http://client.example/x.json"),
    ).rejects.toThrow("https");
  });

  it("uses the Worker's fetch for client metadata, without following redirects", async () => {
    const seen: RequestInit["redirect"][] = [];
    vi.stubGlobal("fetch", async (_input: RequestInfo | URL, init?: RequestInit) => {
      seen.push(init?.redirect);
      return Response.json({ client_id: "https://client.example/x.json" });
    });
    const response = await workerDeps(env).fetchClientMetadata("https://client.example/x.json");
    expect(response.status).toBe(200);
    expect(seen).toEqual(["manual"]);
  });

  it("sends email through the EMAIL binding", async () => {
    const { sent, binding } = fakeEmailBinding();
    await workerDeps({ ...env, EMAIL: binding }).email.send(
      signInCodeEmail("ada@example.test", "123456"),
    );
    expect(sent).toHaveLength(1);
  });
});

describe("Cloudflare email sender", () => {
  it("sends from the Portifact address with text and HTML bodies", async () => {
    const { sent, binding } = fakeEmailBinding();
    const message = signInCodeEmail("ada@example.test", "123456");
    await cloudflareEmailSender(binding).send(message);
    expect(sent).toEqual([
      {
        from: SENDER,
        to: "ada@example.test",
        subject: message.subject,
        text: message.text,
        html: message.html,
      },
    ]);
    expect(SENDER).toEqual({ email: "noreply@portifact.com", name: "Portifact" });
  });

  it("replaces a provider error so the code cannot reach the logs", async () => {
    const { binding } = fakeEmailBinding(true);
    const failure = cloudflareEmailSender(binding).send(
      signInCodeEmail("ada@example.test", "987654"),
    );
    await expect(failure).rejects.toThrow("email delivery failed");
    await expect(failure).rejects.not.toThrow("987654");
  });
});

describe("suppressed recipients", () => {
  const message = signInCodeEmail("gone@example.test", "246810");

  it("recognizes Email Service's suppression refusal by code or message", async () => {
    for (const error of [
      Object.assign(new Error("rejected"), { code: "E_RECIPIENT_SUPPRESSED" }),
      new Error("E_RECIPIENT_SUPPRESSED: gone@example.test is suppressed"),
    ]) {
      const failure = cloudflareEmailSender(fakeEmailBinding(() => error).binding).send(message);
      await expect(failure).rejects.toBeInstanceOf(RecipientSuppressedError);
      await expect(failure).rejects.not.toThrow("gone@example.test");
    }
  });

  it("treats anything else as a plain delivery failure", async () => {
    for (const error of [new Error("E_SENDER_NOT_VERIFIED"), "E_RECIPIENT_SUPPRESSED", null]) {
      const failure = cloudflareEmailSender(fakeEmailBinding(() => error).binding).send(message);
      await expect(failure).rejects.toThrow("email delivery failed");
      await expect(failure).rejects.not.toBeInstanceOf(RecipientSuppressedError);
    }
  });
});

describe("sign-in code email", () => {
  const message = signInCodeEmail("ada@example.test", "123456");

  it("states the code, its lifetime and that it works once, in text and HTML", () => {
    expect(message.to).toBe("ada@example.test");
    expect(message.text).toContain("Your Portifact sign-in code is 123456");
    expect(message.text).toContain("expires in 5 minutes and works once");
    expect(message.html).toContain("<strong>123456</strong>");
    expect(message.html).toContain("expires in 5 minutes and works once");
    expect(message.html).toContain('<html lang="en">');
  });

  it("follows the writing style: no trailing period in the subject or heading, no em dash", () => {
    expect(message.subject).toBe("Your Portifact sign-in code");
    expect(message.subject).not.toMatch(/\.$/);
    expect(message.html).toMatch(/<h1>[^<]*[^.]<\/h1>/);
    for (const part of [message.subject, message.text, message.html]) {
      expect(part).not.toContain("—");
    }
  });

  it("stays monochrome: no colors or inline styles", () => {
    expect(message.html).not.toMatch(/style=|color|#[0-9a-f]{3,6}\b/i);
  });
});

describe("bearer token parsing", () => {
  it("extracts the token from a Bearer header", () => {
    expect(bearerToken("Bearer abc.DEF-123_~+/=")).toBe("abc.DEF-123_~+/=");
  });

  it("ignores other schemes, empty values and missing headers", () => {
    expect(bearerToken("Basic abc")).toBeUndefined();
    expect(bearerToken("Bearer ")).toBeUndefined();
    expect(bearerToken("Bearer a b")).toBeUndefined();
    expect(bearerToken(null)).toBeUndefined();
  });
});
