import { describe, expect, it } from "vitest";
import { CreateThreadRequest, ReplyRequest } from "./annotations.ts";
import {
  HUMAN_VERIFICATION_REQUIRED,
  HumanCheckInput,
  TURNSTILE_SCRIPT_URL,
  TurnstileToken,
} from "./human.ts";
import { ANNOTATION_LIMITS } from "./limits.ts";
import { ERROR_STATUS } from "./publishing.ts";

describe("human check shapes", () => {
  it("accepts a token of 1 to 2,048 characters and nothing else", () => {
    expect(TurnstileToken.safeParse("x").success).toBe(true);
    expect(TurnstileToken.safeParse("x".repeat(2_048)).success).toBe(true);
    expect(TurnstileToken.safeParse("").success).toBe(false);
    expect(TurnstileToken.safeParse("x".repeat(2_049)).success).toBe(false);
    expect(HumanCheckInput.safeParse({ token: "t" }).success).toBe(true);
    expect(HumanCheckInput.safeParse({ token: "t", userId: "u" }).success).toBe(false);
    expect(HumanCheckInput.safeParse({}).success).toBe(false);
  });

  it("lets comments carry an optional token", () => {
    expect(ReplyRequest.parse({ body: "Hi" })).toEqual({ body: "Hi" });
    expect(ReplyRequest.parse({ body: "Hi", turnstileToken: "t" })).toEqual({
      body: "Hi",
      turnstileToken: "t",
    });
    expect(ReplyRequest.safeParse({ body: "Hi", turnstileToken: "" }).success).toBe(false);
    const thread = {
      versionId: "v1",
      target: { schema: 1, path: "index.html", anchor: { kind: "document" } },
      body: "Hi",
    };
    expect(CreateThreadRequest.safeParse({ ...thread, turnstileToken: "t" }).success).toBe(true);
    expect(CreateThreadRequest.safeParse({ ...thread, turnstileToken: 1 }).success).toBe(false);
  });

  it("maps the error to 403 and checks the first three comments", () => {
    expect(ERROR_STATUS[HUMAN_VERIFICATION_REQUIRED]).toBe(403);
    expect(ANNOTATION_LIMITS.humanCheckedComments).toBe(3);
    expect(TURNSTILE_SCRIPT_URL).toBe(
      "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit",
    );
  });
});
