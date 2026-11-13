import { LiveHello, PLANS } from "@portifact/contracts";
import { describe, expect, it } from "vitest";
import { helloMessage, newAttachment } from "./live.ts";

describe("helloMessage", () => {
  it("names the connection and its deadline, as the page's contract reads it", () => {
    const attachment = newAttachment({
      socketId: "AAAAAAAAAAAAAAAA",
      author: null,
      principal: "rs_reader",
      generation: 0,
      liveEpoch: 0,
      deadline: 1_060_000,
      now: 1_000_000,
      limits: PLANS.free.data.perArtifact,
    });
    expect(LiveHello.parse(JSON.parse(helloMessage(attachment)))).toEqual({
      connected: "AAAAAAAAAAAAAAAA",
      deadline: 1_060_000,
    });
  });
});
