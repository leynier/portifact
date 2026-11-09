// @vitest-environment happy-dom
import type { AccessPolicyView } from "@portifact/contracts";
import { axeViolations } from "@portifact/ui/testing";
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { publicAvailableFrom, settingsChange } from "./screens/access-settings.tsx";
import { artifact, type FakeServer, fakeServer, renderDashboard } from "./test-support.tsx";

afterEach(cleanup);

const DAY = 86_400_000;
const ID = "k7d2qm4xab";
const PATH = `/artifacts/${ID}`;
/** Queries retry a failed load once, about a second later. */
const RETRIED = { timeout: 3000 };

const POLICY: AccessPolicyView = {
  mode: "restricted",
  readers: ["ana@example.com"],
  indexable: false,
  embeddable: false,
  bar: true,
  commentVisibility: "owner",
  readerCommentVisibility: [],
  policyGeneration: 4,
};

let server: FakeServer;
beforeEach(() => {
  server = fakeServer([artifact(ID, { name: "Launch plan" })]);
  server.access[ID] = { ...POLICY, readers: [...POLICY.readers] };
});

const accessRegion = async () => screen.findByRole("region", { name: "Access" });
const radio = (name: string) => screen.getByRole("radio", { name }) as HTMLInputElement;
const save = () => fireEvent.click(screen.getByRole("button", { name: "Save access" }));
const patches = () => server.requests.filter((r) => r.method === "PATCH");
const emailField = () => screen.getByRole("textbox", { name: "Email address" }) as HTMLInputElement;

async function addReader(email: string) {
  fireEvent.change(emailField(), { target: { value: email } });
  fireEvent.click(screen.getByRole("button", { name: "Add person" }));
}

describe("access settings", () => {
  it("explains each mode, shows the current one, the reader list and that republishing keeps access", async () => {
    const { container } = renderDashboard(PATH, server);
    const region = await accessRegion();
    await within(region).findByRole("group", { name: "Who can open this artifact" });

    expect(radio("Only you and the people you add").checked).toBe(true);
    expect(region.textContent).toContain("Each person signs in with that address before it opens.");
    expect(region.textContent).toContain("Anyone with the link who signs in to Portifact");
    expect(region.textContent).toContain("Anyone with the link, without signing in.");
    expect(region.textContent).toContain("republishing never opens an artifact to more people");
    expect(radio("Public: anyone with the link").disabled).toBe(false);

    const indexable = screen.getByRole("checkbox", { name: "Let search engines list it" });
    expect((indexable as HTMLInputElement).checked).toBe(false);
    expect(screen.getByRole("checkbox", { name: "Let other sites embed it" })).toBeTruthy();
    expect(region.textContent).toContain("Only applies while the artifact is public.");
    const bar = screen.getByRole("checkbox", { name: "Show the Portifact bar" });
    expect((bar as HTMLInputElement).checked).toBe(true);

    const list = screen.getByRole("list", { name: "People who can open this artifact" });
    expect(
      within(list)
        .getAllByRole("listitem")
        .map((item) => item.firstChild?.textContent),
    ).toEqual(["ana@example.com"]);
    expect(screen.getByText("1 of 500 people")).toBeTruthy();
    expect(await axeViolations(container)).toEqual([]);
  });

  it("turns the Portifact bar off and saves only that", async () => {
    renderDashboard(PATH, server);
    await accessRegion();
    await screen.findByRole("group", { name: "Who can open this artifact" });
    fireEvent.click(screen.getByRole("checkbox", { name: "Show the Portifact bar" }));
    fireEvent.click(screen.getByRole("button", { name: "Save access" }));
    await waitFor(() => expect(server.bodies.at(-1)).toEqual({ bar: false }));
    await waitFor(() => expect(server.access[ID]?.bar).toBe(false));
  });

  it("saves only what changed and announces it, updating the artifact's access", async () => {
    renderDashboard(PATH, server);
    await accessRegion();
    await screen.findByRole("group", { name: "Who can open this artifact" });
    fireEvent.click(radio("Anyone signed in to Portifact"));
    fireEvent.click(screen.getByRole("checkbox", { name: "Let search engines list it" }));
    save();

    expect(
      await screen.findByText(/Access saved\. Anyone who can no longer open the artifact/),
    ).toBeTruthy();
    expect(patches()).toEqual([{ method: "PATCH", path: `/api/v1/artifacts/${ID}/access` }]);
    expect(server.bodies.at(-1)).toEqual({ mode: "authenticated", indexable: true });
    expect(radio("Anyone signed in to Portifact").checked).toBe(true);
    const facts = screen.getByRole("region", { name: "Details" });
    await waitFor(() => expect(facts.textContent).toContain("Anyone signed in to Portifact"));
  });

  it("explains who sees comments, defaults to the owner and saves a change to everyone", async () => {
    const { container } = renderDashboard(PATH, server);
    const region = await accessRegion();
    await within(region).findByRole("group", { name: "Who sees comments" });
    const ownerOnly = radio("Only you, and each person their own");
    expect(ownerOnly.checked).toBe(true);
    expect(region.textContent).toContain(
      "Each person sees the threads they started and the threads you started",
    );
    expect(region.textContent).toContain("You can make an exception for a person you added");
    fireEvent.click(radio("Everyone who can open the artifact"));
    save();
    await screen.findByText(/Access saved/);
    expect(server.bodies.at(-1)).toEqual({ commentVisibility: "everyone" });
    expect(server.access[ID]?.commentVisibility).toBe("everyone");
    expect(await axeViolations(container)).toEqual([]);
  });

  it("sets and clears one reader's exception from the list, following the artifact's default", async () => {
    const { container } = renderDashboard(PATH, server);
    await accessRegion();
    const select = (await screen.findByRole("combobox", {
      name: "Comments ana@example.com sees",
    })) as HTMLSelectElement;
    expect(select.value).toBe("inherit");
    expect(select.selectedOptions[0]?.textContent).toBe("Default: own and yours");
    expect(await axeViolations(container)).toEqual([]);

    fireEvent.change(select, { target: { value: "all" } });
    await screen.findByText("ana@example.com now sees: All comments.");
    expect(server.bodies.at(-1)).toEqual({
      readerCommentVisibility: [{ email: "ana@example.com", commentVisibility: "all" }],
    });
    expect(server.access[ID]?.readerCommentVisibility).toEqual([
      { email: "ana@example.com", commentVisibility: "all" },
    ]);
    await waitFor(() => expect(select.value).toBe("all"));

    fireEvent.change(select, { target: { value: "inherit" } });
    await screen.findByText("ana@example.com now sees: Default: own and yours.");
    expect(server.access[ID]?.readerCommentVisibility).toEqual([]);
  });

  it("names the everyone default in a reader's menu when comments are open to all", async () => {
    server.access[ID] = { ...POLICY, commentVisibility: "everyone" };
    renderDashboard(PATH, server);
    const select = (await screen.findByRole("combobox", {
      name: "Comments ana@example.com sees",
    })) as HTMLSelectElement;
    expect(select.selectedOptions[0]?.textContent).toBe("Default: all comments");
    fireEvent.change(select, { target: { value: "own" } });
    await screen.findByText("ana@example.com now sees: Only own and yours.");
    expect(server.access[ID]?.readerCommentVisibility).toEqual([
      { email: "ana@example.com", commentVisibility: "own" },
    ]);
  });

  it("does not send anything when nothing changed", async () => {
    renderDashboard(PATH, server);
    await screen.findByRole("group", { name: "Who can open this artifact" });
    save();
    expect(
      await screen.findByText("Nothing to save: access is already set this way."),
    ).toBeTruthy();
    expect(patches()).toEqual([]);
  });

  it("keeps public unavailable during the account's first 7 days and says from when", async () => {
    server.createdAt = new Date(Date.now() - 2 * DAY).toISOString();
    const { container } = renderDashboard(PATH, server);
    await screen.findByRole("group", { name: "Who can open this artifact" });
    const publicMode = radio("Public: anyone with the link");
    expect(publicMode.disabled).toBe(true);
    const hint = document.getElementById(publicMode.getAttribute("aria-describedby") ?? "");
    expect(hint?.textContent).toMatch(/Available from .+\. New accounts wait 7 days/);
    expect(await axeViolations(container)).toEqual([]);
  });

  it("keeps a public artifact's mode selectable for a new account, so it can still narrow", async () => {
    server.createdAt = new Date(Date.now() - DAY).toISOString();
    server.access[ID] = { ...POLICY, mode: "public" };
    renderDashboard(PATH, server);
    await screen.findByRole("group", { name: "Who can open this artifact" });
    expect(radio("Public: anyone with the link").disabled).toBe(false);
    fireEvent.click(radio("Only you and the people you add"));
    save();
    await screen.findByText(/Access saved/);
    expect(server.bodies.at(-1)).toEqual({ mode: "restricted" });
  });

  it("explains a refusal because the account is too new", async () => {
    server.createdAt = null;
    server.fail("PATCH", `/api/v1/artifacts/${ID}/access`, {
      status: 403,
      code: "account_too_new_for_public",
    });
    renderDashboard(PATH, server);
    await screen.findByRole("group", { name: "Who can open this artifact" });
    fireEvent.click(radio("Public: anyone with the link"));
    save();
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Access was not saved");
    expect(alert.textContent).toContain(
      "New accounts can make an artifact public 7 days after they are created.",
    );
    // The choice stays, so the user can change it without starting over.
    expect(radio("Public: anyone with the link").checked).toBe(true);
  });

  it("names the date in the refusal when the account's age is known", async () => {
    server.createdAt = "2026-01-10T12:00:00.000Z";
    server.fail("PATCH", `/api/v1/artifacts/${ID}/access`, {
      status: 403,
      code: "account_too_new_for_public",
    });
    renderDashboard(PATH, server);
    await screen.findByRole("group", { name: "Who can open this artifact" });
    fireEvent.click(radio("Public: anyone with the link"));
    save();
    expect((await screen.findByRole("alert")).textContent).toContain("from Jan 17, 2026.");
  });

  it("loads the current policy after a conflict and asks to check it and try again", async () => {
    server.fail("PATCH", `/api/v1/artifacts/${ID}/access`, {
      status: 409,
      code: "version_conflict",
    });
    renderDashboard(PATH, server);
    await screen.findByRole("group", { name: "Who can open this artifact" });
    // Someone else made it public meanwhile.
    server.access[ID] = { ...POLICY, mode: "public", policyGeneration: 5 };
    fireEvent.click(radio("Anyone signed in to Portifact"));
    save();
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Access changed somewhere else meanwhile.");
    await waitFor(() => expect(radio("Public: anyone with the link").checked).toBe(true));
    const reads = server.requests.filter(
      (r) => r.method === "GET" && r.path === `/api/v1/artifacts/${ID}/access`,
    );
    expect(reads.length).toBe(2);
  });

  it("disables every control of a suspended artifact and says why", async () => {
    server.artifacts = [artifact(ID, { state: "suspended" })];
    renderDashboard(PATH, server);
    expect(
      await screen.findByText("This artifact is suspended, so its access cannot change."),
    ).toBeTruthy();
    await screen.findByRole("group", { name: "Who can open this artifact" });
    expect(screen.getByRole("group", { name: "Who can open this artifact" })).toHaveProperty(
      "disabled",
      true,
    );
    expect(screen.getByRole("button", { name: "Save access" })).toHaveProperty("disabled", true);
    expect(screen.getByRole("button", { name: "Remove ana@example.com" })).toHaveProperty(
      "disabled",
      true,
    );
    expect(emailField().disabled).toBe(true);
  });

  it("offers a retry when the policy cannot load", async () => {
    server.fail(
      "GET",
      `/api/v1/artifacts/${ID}/access`,
      { status: 503, code: "capacity_unavailable" },
      2,
    );
    renderDashboard(PATH, server);
    const region = await accessRegion();
    const alert = await within(region).findByRole("alert", {}, RETRIED);
    expect(alert.textContent).toContain("Access settings could not be loaded");
    fireEvent.click(within(alert).getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("group", { name: "Who can open this artifact" })).toBeTruthy();
  });
});

describe("reader list", () => {
  it("adds a valid address, lowercased, clears the field and announces it", async () => {
    renderDashboard(PATH, server);
    await screen.findByRole("group", { name: "Who can open this artifact" });
    await addReader("  Bo@Example.com ");
    expect(await screen.findByText("bo@example.com added.")).toBeTruthy();
    expect(server.bodies.at(-1)).toEqual({ addReaders: ["bo@example.com"] });
    const list = screen.getByRole("list", { name: "People who can open this artifact" });
    expect(within(list).getByText("bo@example.com")).toBeTruthy();
    expect(screen.getByText("2 of 500 people")).toBeTruthy();
    await waitFor(() => expect(emailField().value).toBe(""));
  });

  it("refuses an invalid address next to the field, focuses it and clears the error once fixed", async () => {
    const { container } = renderDashboard(PATH, server);
    await screen.findByRole("group", { name: "Who can open this artifact" });
    await addReader("not-an-email");
    await waitFor(() => expect(emailField().getAttribute("aria-invalid")).toBe("true"));
    expect(screen.getByText("Enter an email address, such as ana@example.com.")).toBeTruthy();
    expect(document.activeElement).toBe(emailField());
    expect(patches()).toEqual([]);
    expect(await axeViolations(container)).toEqual([]);

    fireEvent.change(emailField(), { target: { value: "bo@example.com" } });
    await waitFor(() => expect(emailField().hasAttribute("aria-invalid")).toBe(false));
  });

  it("refuses an address that is already on the list", async () => {
    renderDashboard(PATH, server);
    await screen.findByRole("group", { name: "Who can open this artifact" });
    await addReader("ANA@example.com");
    expect(await screen.findByText("ana@example.com is already on the list.")).toBeTruthy();
    expect(patches()).toEqual([]);
  });

  it("removes a person and says they lose access", async () => {
    renderDashboard(PATH, server);
    fireEvent.click(await screen.findByRole("button", { name: "Remove ana@example.com" }));
    expect(
      await screen.findByText("ana@example.com removed. They lose access within a minute."),
    ).toBeTruthy();
    expect(server.bodies.at(-1)).toEqual({ removeReaders: ["ana@example.com"] });
    expect(await screen.findByText("Nobody yet. Add an email address below.")).toBeTruthy();
    expect(screen.getByText("0 of 500 people")).toBeTruthy();
  });

  it("stops adding at 500 people and says the list is full", async () => {
    server.access[ID] = {
      ...POLICY,
      readers: Array.from({ length: 500 }, (_, i) => `r${String(i).padStart(3, "0")}@example.com`),
    };
    renderDashboard(PATH, server);
    expect(
      await screen.findByText("The list is full: an artifact can have at most 500 people."),
    ).toBeTruthy();
    expect(screen.getByText("500 of 500 people")).toBeTruthy();
    expect(emailField().disabled).toBe(true);
    expect(screen.getByRole("button", { name: "Add person" })).toHaveProperty("disabled", true);
  });

  it("explains the cap when the server refuses an addition and keeps the address", async () => {
    server.fail("PATCH", `/api/v1/artifacts/${ID}/access`, { status: 429, code: "quota_exceeded" });
    renderDashboard(PATH, server);
    await screen.findByRole("group", { name: "Who can open this artifact" });
    await addReader("bo@example.com");
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("The list was not changed");
    expect(alert.textContent).toContain(
      "An artifact can list at most 500 people. Remove someone to add another.",
    );
    expect(emailField().value).toBe("bo@example.com");
  });

  it("reports other failures with the shared message", async () => {
    server.fail("PATCH", `/api/v1/artifacts/${ID}/access`, { status: 0, network: true });
    renderDashboard(PATH, server);
    fireEvent.click(await screen.findByRole("button", { name: "Remove ana@example.com" }));
    expect((await screen.findByRole("alert")).textContent).toContain(
      "Portifact could not be reached.",
    );
  });
});

describe("access helpers", () => {
  it("dates public access 7 days after the account was created, when known", () => {
    expect(publicAvailableFrom(null)).toBeNull();
    expect(publicAvailableFrom({ email: "a", name: "", createdAt: null })).toBeNull();
    expect(publicAvailableFrom({ email: "a", name: "", createdAt: "garbage" })).toBeNull();
    expect(
      publicAvailableFrom({ email: "a", name: "", createdAt: "2026-11-01T00:00:00.000Z" }),
    ).toEqual(new Date("2026-11-08T00:00:00.000Z"));
  });

  it("sends only the settings that differ", () => {
    const policy = {
      mode: "restricted" as const,
      readers: [],
      indexable: false,
      embeddable: true,
      bar: true,
      commentVisibility: "owner" as const,
      readerCommentVisibility: [],
      policyGeneration: 1,
    };
    const same = { mode: "restricted", indexable: false, embeddable: true, bar: true } as const;
    expect(settingsChange(policy, { ...same, commentVisibility: "owner" })).toBe(undefined);
    expect(settingsChange(policy, { ...same, commentVisibility: "everyone" })).toEqual({
      commentVisibility: "everyone",
    });
    expect(
      settingsChange(policy, {
        mode: "public",
        indexable: true,
        embeddable: false,
        bar: true,
        commentVisibility: "owner",
      }),
    ).toEqual({
      mode: "public",
      indexable: true,
      embeddable: false,
    });
    expect(
      settingsChange(policy, {
        mode: "restricted",
        indexable: false,
        embeddable: true,
        bar: false,
        commentVisibility: "owner",
      }),
    ).toEqual({ bar: false });
  });
});
