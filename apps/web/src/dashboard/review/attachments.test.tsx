// @vitest-environment happy-dom
// The viewer's comment attachments (decision 0028): adding files and screenshots, the limits the
// page checks before asking the API, and showing and saving files only after their bytes match
// what the message lists.

import { I18nProvider } from "@lingui/react";
import type { AttachmentView } from "@portifact/contracts";
import { axeViolations } from "@portifact/ui/testing";
import { QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { dashboardApi } from "../api.ts";
import { DashboardContext } from "../context.tsx";
import { createI18n } from "../i18n/i18n.ts";
import { inProcessBuilder } from "../publish/builder.ts";
import type { SavedFile } from "../publish/download.ts";
import { sha256OfBlob } from "../publish/hash.ts";
import type { StorageTransport } from "../publish/upload.ts";
import { createQueryClient } from "../query-client.ts";
import {
  AttachmentControls,
  AttachmentsContext,
  attachmentName,
  MessageAttachments,
  savedName,
  useAttachmentUploads,
} from "./attachments.tsx";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

interface Fakes {
  requests: { method: string; path: string; body: unknown }[];
  puts: { url: string; headers: Record<string, string>; size: number }[];
  stored: Map<string, Blob>;
  saved: SavedFile[];
  putStatus: number;
}

let fakes: Fakes;

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

async function fakeFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = new URL(String(input), "https://app.portifact.test");
  const method = init?.method ?? "GET";
  const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
  fakes.requests.push({ method, path: url.pathname, body });
  const prepare = /^\/api\/v1\/artifacts\/([^/]+)\/annotations\/attachments$/.exec(url.pathname);
  if (prepare && method === "POST") {
    const id = `att_${fakes.requests.length}`;
    return json(
      {
        attachment: {
          id,
          name: body.name,
          size: body.size,
          sha256: body.sha256,
          expiresAt: "2026-11-14T13:00:00.000Z",
        },
        upload: {
          url: `https://storage.test/attachments/${id}`,
          headers: { "content-length": String(body.size), "x-amz-checksum-sha256": "x" },
          expiresAt: "2026-11-14T12:15:00.000Z",
        },
      },
      201,
    );
  }
  const link = /^\/api\/v1\/artifacts\/[^/]+\/annotations\/attachments\/([^/]+)$/.exec(
    url.pathname,
  );
  if (link && method === "GET") {
    const id = link[1] as string;
    return json({
      attachment: { id, name: "x", contentType: "image/png", size: 0, sha256: "" },
      url: `https://storage.test/attachments/${id}`,
      expiresAt: "2026-11-14T12:05:00.000Z",
    });
  }
  return json({ error: { code: "not_found", message: "Not found." } }, 404);
}

const storage: StorageTransport = {
  async put(request, body) {
    fakes.puts.push({ url: request.url, headers: request.headers, size: body.size });
    if (fakes.putStatus === 200) fakes.stored.set(request.url, body);
    return { status: fakes.putStatus };
  },
  async get(url) {
    const blob = fakes.stored.get(url);
    if (!blob) throw new Error("missing");
    return blob;
  },
};

function renderWith(node: React.ReactNode, attachments = true) {
  const env = {
    api: dashboardApi({ fetch: fakeFetch, onUnauthenticated: () => {} }),
    leave: () => {},
    manifests: inProcessBuilder,
    storage,
    save: (file: SavedFile) => {
      fakes.saved.push(file);
    },
    humanCheck: null,
  };
  return render(
    <I18nProvider i18n={createI18n()}>
      <QueryClientProvider client={createQueryClient()}>
        <DashboardContext.Provider value={env}>
          <AttachmentsContext.Provider value={attachments}>{node}</AttachmentsContext.Provider>
        </DashboardContext.Provider>
      </QueryClientProvider>
    </I18nProvider>,
  );
}

/** A composer's controls and what it would post. */
function Composer() {
  const uploads = useAttachmentUploads("art1");
  const ids = uploads.files.flatMap((file) => (file.id ? [file.id] : []));
  return (
    <div>
      <AttachmentControls uploads={uploads} />
      <output aria-label="ready ids">{ids.join(",")}</output>
      <button type="button" onClick={() => uploads.toPost()}>
        Post
      </button>
    </div>
  );
}

function pick(...files: File[]) {
  const input = document.querySelector('input[type="file"]') as HTMLInputElement;
  fireEvent.change(input, { target: { files } });
}

beforeEach(() => {
  fakes = { requests: [], puts: [], stored: new Map(), saved: [], putStatus: 200 };
  let next = 0;
  vi.stubGlobal("URL", Object.assign(URL, { createObjectURL: () => `blob:test/${++next}` }));
  URL.revokeObjectURL = () => {};
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("adding files", () => {
  it("uploads a chosen file straight to storage and keeps it ready to post", async () => {
    renderWith(<Composer />);
    pick(new File([PNG], "shot.png", { type: "image/png" }));
    expect(await screen.findByText(/Ready/)).toBeTruthy();
    const prepare = fakes.requests.find((r) => r.method === "POST");
    expect(prepare?.body).toEqual({
      name: "shot.png",
      size: PNG.length,
      sha256: await sha256OfBlob(new Blob([PNG])),
    });
    expect(fakes.puts).toHaveLength(1);
    expect(screen.getByLabelText("ready ids").textContent).toMatch(/^att_/);
    expect(screen.getByRole("img", { name: "Preview of shot.png" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Remove shot.png" }));
    expect(screen.queryByText("shot.png")).toBeNull();
  });

  it("refuses an empty file, a file over 10 MB and a fifth file before asking the API", async () => {
    renderWith(<Composer />);
    pick(new File([], "empty.txt", { type: "text/plain" }));
    expect((await screen.findByRole("alert")).textContent).toBe("empty.txt is empty.");
    pick(new File([new Uint8Array(10 * 1024 * 1024 + 1)], "big.png", { type: "image/png" }));
    expect((await screen.findByRole("alert")).textContent).toBe("big.png is larger than 10 MB.");
    expect(fakes.requests).toHaveLength(0);
    for (let i = 0; i < 4; i++) pick(new File([PNG], `s${i}.png`, { type: "image/png" }));
    await waitFor(() => expect(screen.getAllByText(/Ready/)).toHaveLength(4));
    expect(screen.getByLabelText("Attach a file")).toHaveProperty("disabled", true);
  });

  it("keeps a comment from going out while a file failed to upload", async () => {
    fakes.putStatus = 403;
    renderWith(<Composer />);
    pick(new File([PNG], "shot.png", { type: "image/png" }));
    expect(await screen.findByText(/Upload failed/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Post" }));
    expect((await screen.findByRole("alert")).textContent).toBe(
      "Wait until every file is uploaded, or remove the ones that failed.",
    );
  });

  it("offers a screenshot only where the browser can capture the screen", async () => {
    const { unmount } = renderWith(<Composer />);
    expect(screen.queryByRole("button", { name: "Attach a screenshot" })).toBeNull();
    unmount();
    const getDisplayMedia = vi
      .fn()
      .mockRejectedValue(new DOMException("denied", "NotAllowedError"));
    vi.stubGlobal("navigator", { ...navigator, mediaDevices: { getDisplayMedia } });
    renderWith(<Composer />);
    fireEvent.click(screen.getByRole("button", { name: "Attach a screenshot" }));
    // A warning first: the capture uploads at once, so nothing is asked of the browser yet.
    expect(screen.getByText(/uploads the capture right away, before you post/)).toBeTruthy();
    expect(getDisplayMedia).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByText(/uploads the capture right away/)).toBeNull();
    expect(getDisplayMedia).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Attach a screenshot" }));
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect((await screen.findByRole("alert")).textContent).toBe("The screenshot was not taken.");
    expect(getDisplayMedia).toHaveBeenCalledOnce();
    expect(fakes.requests).toHaveLength(0);
  });
});

describe("files on messages", () => {
  async function stored(bytes: Uint8Array<ArrayBuffer>, contentType: string, name: string) {
    const id = "att_9";
    fakes.stored.set(`https://storage.test/attachments/${id}`, new Blob([bytes]));
    const file: AttachmentView = {
      id,
      name,
      contentType,
      size: bytes.length,
      sha256: await sha256OfBlob(new Blob([bytes])),
    };
    return file;
  }

  it("shows a checked image and saves it under a name its type allows", async () => {
    const file = await stored(PNG, "image/png", "report.html");
    renderWith(<MessageAttachments artifactId="art1" files={[file]} />);
    const image = await screen.findByRole("img", { name: "report.html" });
    expect(image.getAttribute("src")).toMatch(/^blob:/);
    const list = screen.getByRole("list", { name: "Attached files" });
    fireEvent.click(
      within(list).getAllByRole("button", { name: "Download report.html" })[1] as HTMLElement,
    );
    await waitFor(() => expect(fakes.saved).toHaveLength(1));
    expect(fakes.saved[0]?.fileName).toBe("report.html.png");
    expect(fakes.saved[0]?.blob.type).toBe("image/png");
  });

  it("never shows images where attachments are off, and offers only the download", async () => {
    const file = await stored(PNG, "image/png", "shot.png");
    renderWith(<MessageAttachments artifactId="art1" files={[file]} />, false);
    expect(screen.queryByRole("img")).toBeNull();
    expect(screen.getByRole("button", { name: "Download shot.png" })).toBeTruthy();
  });

  it("saves nothing when the bytes differ from what the message lists", async () => {
    const file = await stored(new TextEncoder().encode("notes"), "text/plain", "notes");
    fakes.stored.set(`https://storage.test/attachments/${file.id}`, new Blob(["other"]));
    renderWith(<MessageAttachments artifactId="art1" files={[file]} />);
    fireEvent.click(screen.getByRole("button", { name: "Download notes" }));
    expect((await screen.findByRole("alert")).textContent).toBe("notes could not be loaded.");
    expect(fakes.saved).toHaveLength(0);
  });
});

describe("accessibility", () => {
  it("has no violations with a file ready and a file on a message", async () => {
    const id = "att_9";
    fakes.stored.set(`https://storage.test/attachments/${id}`, new Blob([PNG]));
    const { container } = renderWith(
      <>
        <Composer />
        <MessageAttachments
          artifactId="art1"
          files={[
            {
              id,
              name: "shot.png",
              contentType: "image/png",
              size: PNG.length,
              sha256: await sha256OfBlob(new Blob([PNG])),
            },
          ]}
        />
      </>,
    );
    pick(new File([PNG], "draft.png", { type: "image/png" }));
    await screen.findByText(/Ready/);
    await screen.findByRole("img", { name: "shot.png" });
    expect(await axeViolations(container)).toEqual([]);
  });
});

describe("names", () => {
  it("cleans names and keeps the extension of a long one", () => {
    expect(attachmentName("a/b\\c\u0007.png", "x")).toBe("a b c .png");
    expect(attachmentName("   ", "screenshot")).toBe("screenshot");
    const long = `${"x".repeat(300)}.png`;
    expect(attachmentName(long, "x")).toHaveLength(200);
    expect(attachmentName(long, "x").endsWith(".png")).toBe(true);
    expect(savedName({ name: "photo.JPEG", contentType: "image/jpeg" })).toBe("photo.JPEG");
    expect(savedName({ name: "log", contentType: "text/plain" })).toBe("log.txt");
  });
});
