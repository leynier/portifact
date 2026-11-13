import { env } from "cloudflare:test";
import { expect, it } from "vitest";
import { planSuggestion } from "../src/suggestion-plans.ts";
import { submitSuggestion } from "../src/suggestions.ts";
import { db, NOW, user, value } from "./fixtures.ts";
import { DOMAIN, humanCheck, PAGE, publishDoc, textOp } from "./suggestion-support.ts";

it("R9: refuse a file over the HTML planning limit before buffering its body", async () => {
  const owner = await user("Owner");
  const body = PAGE + " ".repeat(1_100_000);
  const doc = await publishDoc(owner.id, { type: "site", body });
  const input = { userId: owner.id, artifactId: doc.artifactId, now: NOW };
  const suggestion = value(
    await submitSuggestion(db(), {
      ...input,
      versionId: doc.versionId,
      edit: { operations: [textOp(doc, PAGE, "Second", "Next")] },
      body: "Fix",
      humanCheck,
    }),
  );
  let buffered = 0;
  const bucket = new Proxy(env.ARTIFACTS, {
    get(target, prop) {
      if (prop === "get")
        return async (key: string) => {
          const object = await target.get(key);
          if (!object) return null;
          return new Proxy(object, {
            get(o, field) {
              if (field === "arrayBuffer")
                return async () => {
                  buffered += o.size;
                  return o.arrayBuffer();
                };
              const member = Reflect.get(o, field, o);
              return typeof member === "function" ? member.bind(o) : member;
            },
          });
        };
      const member = Reflect.get(target, prop, target);
      return typeof member === "function" ? member.bind(target) : member;
    },
  });
  const plan = value(
    await planSuggestion(db(), bucket, {
      ...input,
      threadId: suggestion.id,
      contentDomain: DOMAIN,
    }),
  );
  expect(plan.listed[0]?.reason).toBe("too_large");
  expect(buffered).toBe(0);
});
