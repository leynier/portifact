// The device page: the user enters or confirms the code the CLI shows, reviews what the CLI
// asks for, then approves or denies. Opening a code binds it to the signed-in user, so nobody
// else can approve it.
import { type Api, currentUserEmail, field } from "./api.ts";
import {
  announce,
  byId,
  fillList,
  hideSummary,
  setFieldError,
  showSummary,
  whileBusy,
} from "./dom.ts";
import type { PageEnv } from "./login.ts";
import { messages } from "./messages.ts";
import { loginUrl } from "./query.ts";
import { describeResource, describeScopes } from "./scopes.ts";

export async function setupDevice(doc: Document, env: PageEnv): Promise<void> {
  const { api, location } = env;
  const initialCode = new URLSearchParams(location.search).get("user_code")?.trim() ?? "";

  const email = await currentUserEmail(api);
  if (!email) {
    const back = initialCode
      ? `/device?${new URLSearchParams({ user_code: initialCode })}`
      : "/device";
    location.assign(loginUrl(back));
    return;
  }

  const summary = byId(doc, "error-summary");
  const status = byId(doc, "status");
  const codeForm = byId<HTMLFormElement>(doc, "code-form");
  const codeInput = byId<HTMLInputElement>(doc, "user-code");
  const codeError = byId(doc, "user-code-error");
  const review = byId(doc, "review");
  const done = byId(doc, "done");
  let userCode = "";

  byId(doc, "signed-in-email").textContent = messages.signedInAs(email);
  codeForm.hidden = false;
  codeInput.value = initialCode;

  const fail = (message: string) => {
    setFieldError(codeInput, codeError, message);
    showSummary(summary, message);
  };

  const open = async (code: string) => {
    hideSummary(summary);
    if (!code) {
      fail(messages.deviceCodeRequired);
      return;
    }
    const response = await api.get(`/device?${new URLSearchParams({ user_code: code })}`);
    if (response.status === 0) {
      showSummary(summary, messages.network);
      return;
    }
    if (response.status !== 200) {
      fail(messages.deviceCodeInvalid);
      return;
    }
    if (field(response.body, "status") !== "pending") {
      fail(messages.deviceProcessed);
      return;
    }
    const clientId = field(response.body, "client_id");
    if (!clientId) {
      fail(messages.deviceCodeTaken);
      return;
    }
    setFieldError(codeInput, codeError, undefined);
    userCode = code;
    await showReview(doc, api, env.origin, {
      clientId,
      scope: field(response.body, "scope") ?? "",
      resource: resourceOf(response.body),
      userCode: field(response.body, "user_code") ?? code,
    });
    codeForm.hidden = true;
    review.hidden = false;
    byId(doc, "review-heading").focus();
  };

  codeForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    await open(codeInput.value.trim());
  });

  const decide = (action: "approve" | "deny", message: string) => async (event: Event) => {
    hideSummary(summary);
    const button = event.currentTarget as HTMLButtonElement;
    const response = await whileBusy(button, () => api.post(`/device/${action}`, { userCode }));
    if (response.status !== 200) {
      showSummary(summary, response.status === 0 ? messages.network : messages.deviceProcessed);
      return;
    }
    review.hidden = true;
    byId(doc, "done-message").textContent = message;
    done.hidden = false;
    announce(status, message);
  };
  byId(doc, "approve").addEventListener("click", decide("approve", messages.deviceApproved));
  byId(doc, "deny").addEventListener("click", decide("deny", messages.deviceDenied));

  if (initialCode) await open(initialCode);
}

interface DeviceRequest {
  clientId: string;
  scope: string;
  resource: string[];
  userCode: string;
}

async function showReview(doc: Document, api: Api, origin: string, request: DeviceRequest) {
  const client = await api.get(
    `/oauth2/public-client?${new URLSearchParams({ client_id: request.clientId })}`,
  );
  byId(doc, "client-name").textContent =
    (client.status === 200 && field(client.body, "client_name")) || request.clientId;
  byId(doc, "review-code").textContent = request.userCode;
  fillList(byId(doc, "scopes"), describeScopes(request.scope));
  byId(doc, "resource").textContent = request.resource
    .map((resource) => describeResource(resource, origin))
    .join(", ");
}

function resourceOf(body: unknown): string[] {
  const value = (body as Record<string, unknown>).resource;
  if (typeof value === "string") return [value];
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}
