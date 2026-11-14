// The page's reach in `read` and `shared` collections (decision 0026, delivery 9), against both
// objects: page callers carry `PAGE_MODES` exactly as the content Worker's commands and live
// connections do (`pageCaller`), and every rule is the domain's scope rules applied by the object.
import type { CollectionMode, PageCaller } from "@portifact/contracts/artifact-data";
import { describe, expect, it } from "vitest";
import { PAGE_MODES } from "../../artifact-data/documents.ts";
import { pageCaller } from "../../artifact-data/page-commands.ts";
import type { MakeObject } from "../artifact-data-driver.ts";
import { context, envelope, NOW, OWNER, op, value, visitorId } from "../artifact-data-fixtures.ts";

const ALICE = pageCaller({ kind: "visitor", author: visitorId("alice"), canWrite: true });
const BOB = pageCaller({ kind: "visitor", author: visitorId("bob"), canWrite: true });
/** A grant holder without the current terms: no writes, yet their own deletes and export. */
const CAROL = pageCaller({ kind: "visitor", author: visitorId("carol"), canWrite: false });
const READER = pageCaller({ kind: "reader" } satisfies PageCaller);

export function pageModesSuite(make: MakeObject): void {
  const ctx = context();

  async function withCollections(...modes: CollectionMode[]) {
    const object = await make("page-modes");
    const base = envelope();
    for (const mode of modes) {
      value(await object.declare(op(base), OWNER, { name: mode, mode }, ctx));
    }
    return { object, base };
  }

  describe("page modes (delivery 9)", () => {
    it("reaches every collection mode", () => {
      expect([...PAGE_MODES].sort()).toEqual(["append", "own", "read", "shared"]);
    });

    it("lets every page caller read a read collection and none of them write to it", async () => {
      const { object, base } = await withCollections("read");
      const doc = value<{ _id: string }>(
        await object.create(op(base), OWNER, "read", { title: "menu" }, ctx),
      );
      for (const caller of [ALICE, CAROL, READER]) {
        expect(value(await object.get(base, caller, "read", doc._id, ctx))).toMatchObject({
          title: "menu",
        });
        const page = value(await object.query(base, caller, { collection: "read" }, ctx));
        expect(page.documents).toHaveLength(1);
        expect((await object.create(op(base), caller, "read", { title: "x" }, ctx)).ok).toBe(false);
        expect(
          (await object.replace(op(base), caller, "read", doc._id, { title: "x" }, ctx)).ok,
        ).toBe(false);
        expect((await object.remove(op(base), caller, "read", doc._id, ctx)).ok).toBe(false);
      }
      expect(value(await object.get(base, READER, "read", doc._id, ctx))).toMatchObject({
        title: "menu",
      });
    });

    it("lets any writer change and delete anyone's document in a shared collection", async () => {
      const { object, base } = await withCollections("shared");
      const doc = value<{ _id: string }>(
        await object.create(op(base), ALICE, "shared", { text: "a" }, ctx),
      );
      expect(value(await object.get(base, BOB, "shared", doc._id, ctx))).toMatchObject({
        text: "a",
        _by: visitorId("alice"),
      });
      expect(
        value(await object.replace(op(base), BOB, "shared", doc._id, { text: "b" }, ctx)),
      ).toMatchObject({ text: "b", _by: visitorId("alice"), _editedBy: visitorId("bob") });
      // A reader reads it but never writes; a grant holder without the terms neither.
      expect(value(await object.get(base, READER, "shared", doc._id, ctx))).toMatchObject({
        text: "b",
      });
      for (const caller of [READER, CAROL]) {
        expect(
          (await object.replace(op(base), caller, "shared", doc._id, { text: "c" }, ctx)).ok,
        ).toBe(false);
        expect((await object.remove(op(base), caller, "shared", doc._id, ctx)).ok).toBe(false);
        expect((await object.create(op(base), caller, "shared", { text: "c" }, ctx)).ok).toBe(
          false,
        );
      }
      value(await object.remove(op(base), BOB, "shared", doc._id, ctx));
      expect((await object.get(base, ALICE, "shared", doc._id, ctx)).ok).toBe(false);
    });

    it("keeps a creator's own delete in a shared collection without write permission", async () => {
      const { object, base } = await withCollections("shared");
      const carolWriting = pageCaller({
        kind: "visitor",
        author: visitorId("carol"),
        canWrite: true,
      });
      const doc = value<{ _id: string }>(
        await object.create(op(base), carolWriting, "shared", { text: "mine" }, ctx),
      );
      value(await object.remove(op(base), CAROL, "shared", doc._id, ctx));
    });

    it("keeps own documents private beside shared ones", async () => {
      const { object, base } = await withCollections("own", "shared");
      const mine = value<{ _id: string }>(
        await object.create(op(base), ALICE, "own", { secret: 1 }, ctx),
      );
      expect((await object.get(base, BOB, "own", mine._id, ctx)).ok).toBe(false);
      expect((await object.replace(op(base), BOB, "own", mine._id, { secret: 2 }, ctx)).ok).toBe(
        false,
      );
      expect((await object.remove(op(base), BOB, "own", mine._id, ctx)).ok).toBe(false);
      const readerPage = value(await object.query(base, READER, { collection: "own" }, ctx));
      expect(readerPage.documents).toEqual([]);
    });

    it("sends shared and read changes to every page connection subscribed, own ones only to their creator", async () => {
      const { object, base } = await withCollections("own", "read", "shared");
      const live = context();
      const open = async (author: string | null, principal: string) => {
        const socket = value(
          await object.connect(base, author, principal, NOW + 60_000, live, PAGE_MODES),
        );
        for (const name of ["own", "read", "shared"]) {
          await object.message(socket, JSON.stringify({ subscribe: name }), NOW);
        }
        return socket;
      };
      const bob = await open(visitorId("bob"), "grant:bob");
      const reader = await open(null, "public");
      value(await object.create(op(base), ALICE, "shared", { n: 1 }, live));
      value(await object.create(op(base), OWNER, "read", { n: 2 }, live));
      value(await object.create(op(base), ALICE, "own", { n: 3 }, live));
      const view = await object.view();
      for (const socket of [bob, reader]) {
        const received = view.sockets.get(socket)?.received ?? [];
        const changes = received.filter((message) => message.includes('"created"'));
        expect(changes.some((message) => message.includes('"collection":"shared"'))).toBe(true);
        expect(changes.some((message) => message.includes('"collection":"read"'))).toBe(true);
        expect(changes.some((message) => message.includes('"collection":"own"'))).toBe(false);
      }
    });
  });
}
