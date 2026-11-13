// @vitest-environment happy-dom
import type { DataDescriptionView, DataDocumentView } from "@portifact/contracts";
import { parseExportFile } from "@portifact/domain/artifact-data";
import { axeViolations } from "@portifact/ui/testing";
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { artifact, type FakeServer, fakeServer, renderDashboard } from "./test-support.tsx";

afterEach(cleanup);

const ID = "k7d2qm4xab";
const PATH = `/artifacts/${ID}`;
const DAY = {
  day: 20_400,
  growth: 40,
  read: 1_200,
  cleanup: 0,
  export: 0,
  rights: 0,
  protected: 0,
  live: 0,
  refused: 0,
  intents: 0,
};

function description(exists = true): DataDescriptionView {
  return {
    artifactId: ID,
    exists,
    generation: 0,
    revision: exists ? 3 : 0,
    collections: exists
      ? [
          {
            name: "votes",
            mode: "own",
            uniqueKey: null,
            indexed: [{ field: "choice", state: "ready" }],
            documents: 3,
            bytes: 120,
          },
          {
            name: "notes",
            mode: "shared",
            uniqueKey: null,
            indexed: [{ field: "tag", state: "building" }],
            documents: 0,
            bytes: 0,
          },
        ]
      : [],
    today: DAY,
    limits: {
      bytesPerArtifact: 5_000_000,
      documentBytes: 16_384,
      documentsPerCollection: 1_000,
      collections: 10,
      indexedFields: 3,
      rowsReadPerDay: 500_000,
      rowsWrittenPerDay: 5_000,
      cleanupRowsPerDay: 5_000,
      exportRowsPerDay: 200_000,
    },
    storedBytes: 2_048,
  };
}

function doc(n: number, body: Record<string, unknown>): DataDocumentView {
  return {
    _id: `AAAAAAAAAAAAAA${String(n).padStart(2, "0")}`,
    _by: "v_visitor0000000000000",
    _editedBy: null,
    _created: 1_700_000_000_000 + n,
    _updated: 1_700_000_000_000 + n,
    _seq: n,
    ...body,
  };
}

let server: FakeServer;
beforeEach(() => {
  server = fakeServer([artifact(ID, { name: "Launch plan" })]);
});

const section = () => screen.findByRole("region", { name: "Data" });

describe("the artifact's data section", () => {
  it("lists collections, today's use and the documents as text, never as markup", async () => {
    server.data[ID] = {
      description: description(),
      documents: {
        votes: [doc(1, { choice: "<img src=x onerror=alert(1)>" }), doc(2, { choice: "b" })],
        notes: [],
      },
    };
    const { container } = renderDashboard(PATH, server);
    const region = await section();
    const table = await within(region).findByRole("table", {
      name: "Collections of this artifact",
    });
    expect(within(table).getAllByRole("row")).toHaveLength(3);
    expect(table.textContent).toContain("Each writer their own");
    expect(table.textContent).toContain("tag (building)");
    expect(region.textContent).toContain("1,200 of 500,000");
    const first = await within(region).findByRole("region", { name: "Document AAAAAAAAAAAAAA01" });
    expect(first.textContent).toContain('"choice": "<img src=x onerror=alert(1)>"');
    expect(region.querySelector("img")).toBeNull();
    expect(region.textContent).toContain("untrusted text");
    expect(await axeViolations(container)).toEqual([]);
  });

  it("pages through a collection and goes back to the first page", async () => {
    server.data[ID] = {
      description: description(),
      documents: {
        votes: Array.from({ length: 25 }, (_, n) => doc(n, { n })),
        notes: [],
      },
    };
    renderDashboard(PATH, server);
    const region = await section();
    await within(region).findByRole("region", { name: "Document AAAAAAAAAAAAAA00" });
    fireEvent.click(within(region).getByRole("button", { name: "Next page" }));
    await within(region).findByRole("region", { name: "Document AAAAAAAAAAAAAA20" });
    expect(within(region).queryByRole("button", { name: "Next page" })).toBeNull();
    fireEvent.click(within(region).getByRole("button", { name: "First page" }));
    await within(region).findByRole("region", { name: "Document AAAAAAAAAAAAAA00" });
  });

  it("says when a collection has no documents", async () => {
    server.data[ID] = { description: description(), documents: { votes: [], notes: [] } };
    renderDashboard(PATH, server);
    const region = await section();
    expect(await within(region).findByText("This collection has no documents.")).toBeTruthy();
  });

  it("shows an empty state before anything was stored", async () => {
    server.data[ID] = { description: description(false), documents: {} };
    renderDashboard(PATH, server);
    const region = await section();
    expect(await within(region).findByText("No data yet")).toBeTruthy();
  });

  it("is not shown while artifact data is off or refused", async () => {
    renderDashboard(PATH, server);
    await screen.findByRole("region", { name: "Analytics" });
    await waitFor(() =>
      expect(server.requests.some((request) => request.path.endsWith("/data"))).toBe(true),
    );
    expect(screen.queryByRole("region", { name: "Data" })).toBeNull();
    expect(screen.queryByRole("link", { name: "Data" })).toBeNull();
  });

  it("downloads the export as JSON Lines with the stored bodies", async () => {
    server.data[ID] = {
      description: description(),
      documents: { votes: [doc(1, { choice: "a" }), doc(2, { choice: "b" })], notes: [] },
    };
    const { saved } = renderDashboard(PATH, server);
    const region = await section();
    fireEvent.click(await within(region).findByRole("button", { name: "Export as JSON Lines" }));
    await waitFor(() => expect(saved).toHaveLength(1));
    const file = saved[0];
    if (!file) throw new Error("nothing saved");
    expect(file.fileName).toBe("Launch plan-data.jsonl");
    const parsed = parseExportFile(await file.blob.text());
    if (!parsed.ok) throw new Error(parsed.message);
    expect(parsed.value.header.collections.map((item) => item.name)).toEqual(["votes", "notes"]);
    expect(parsed.value.rows.map((row) => row.body)).toEqual([{ choice: "a" }, { choice: "b" }]);
    expect(parsed.value.footer).toMatchObject({ consistent: true, documents: 2 });
  });
});
