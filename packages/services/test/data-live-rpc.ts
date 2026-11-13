// The documents object's live methods (`fetch` for the upgrade, `liveRenew`) over the in-memory
// reference object, as apps/data's `ArtifactDocuments` serves them over the store: a connect
// answers `101` with a client end, after the hello message the reference records.
import { LIVE_CONNECT_HEADER, LiveConnectRequest } from "@portifact/contracts";
import type { MemoryObject } from "@portifact/domain/testing/artifact-data";
import type { DataObjectRpc } from "../src/artifact-data.ts";

export function liveRpc(memory: MemoryObject): Pick<DataObjectRpc, "fetch" | "liveRenew"> {
  return {
    fetch: async (request) => {
      const parsed = LiveConnectRequest.safeParse(
        JSON.parse(request.headers.get(LIVE_CONNECT_HEADER) ?? "null"),
      );
      if (!parsed.success)
        return Response.json({ ok: false, code: "invalid_input" }, { status: 400 });
      const input = parsed.data;
      const answer = memory.connect(input.envelope, input.author, input.principal, input.deadline, {
        now: input.now,
        limits: input.limits,
      });
      if (!answer.ok) return Response.json(answer, { status: 409 });
      const socketId = "value" in answer ? answer.value : "";
      memory.hello(socketId, input.now);
      const pair = new WebSocketPair();
      pair[1].accept();
      return new Response(null, { status: 101, webSocket: pair[0] });
    },
    liveRenew: async (envelope, socketId, principal, deadline, limits, now) =>
      memory.renew(envelope, socketId, principal, deadline, { now, limits }),
  };
}
