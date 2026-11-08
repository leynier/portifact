// The login page: Google, GitHub or an email code. When an OAuth client sent the user here,
// the signed authorization request goes back with the sign-in, and Better Auth continues to
// the consent page.
import { type Api, currentUserEmail, field, type PageLocation } from "./api.ts";
import { announce, byId, hideSummary, setFieldError, showSummary, whileBusy } from "./dom.ts";
import { messages } from "./messages.ts";
import { safeNext, signedOAuthQuery } from "./query.ts";

export interface PageEnv {
  api: Api;
  location: PageLocation;
  /** This page's origin, for example https://app.portifact.com. */
  origin: string;
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const CODE_PATTERN = /^\d{6}$/;

export async function setupLogin(doc: Document, env: PageEnv): Promise<void> {
  const { api, location } = env;
  const oauthQuery = signedOAuthQuery(location.search);
  const next = safeNext(location.search, env.origin);
  const afterSignIn = next ?? "/login";

  const summary = byId(doc, "error-summary");
  const status = byId(doc, "status");
  const signIn = byId(doc, "sign-in");
  const emailForm = byId<HTMLFormElement>(doc, "email-form");
  const emailInput = byId<HTMLInputElement>(doc, "email");
  const emailError = byId(doc, "email-error");
  const codeForm = byId<HTMLFormElement>(doc, "code-form");
  const codeInput = byId<HTMLInputElement>(doc, "code");
  const codeError = byId(doc, "code-error");

  const providerError = new URLSearchParams(location.search).get("error");
  if (providerError) {
    showSummary(summary, messages.providerErrors[providerError] ?? messages.providerErrorFallback);
  }

  const withQuery = (body: Record<string, unknown>) =>
    oauthQuery ? { ...body, oauth_query: oauthQuery } : body;

  const failed = (statusCode: number) =>
    showSummary(
      summary,
      statusCode === 0
        ? messages.network
        : statusCode === 429
          ? messages.rateLimited
          : messages.unexpected,
    );

  for (const button of doc.querySelectorAll<HTMLButtonElement>("button[data-provider]")) {
    button.addEventListener("click", async () => {
      hideSummary(summary);
      const response = await whileBusy(button, () =>
        api.post(
          "/sign-in/social",
          withQuery({
            provider: button.dataset.provider,
            callbackURL: afterSignIn,
            errorCallbackURL: "/login",
          }),
        ),
      );
      const url = field(response.body, "url");
      if (response.status === 200 && url) {
        announce(status, messages.redirecting);
        location.assign(url);
      } else {
        failed(response.status);
      }
    });
  }

  let email = "";
  const sendCode = async (button: HTMLButtonElement): Promise<boolean> => {
    const response = await whileBusy(button, () =>
      api.post("/email-otp/send-verification-otp", { email, type: "sign-in" }),
    );
    if (response.status === 200) return true;
    failed(response.status);
    return false;
  };

  emailForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    hideSummary(summary);
    const value = emailInput.value.trim();
    const problem = !value
      ? messages.emailRequired
      : EMAIL_PATTERN.test(value)
        ? undefined
        : messages.emailInvalid;
    setFieldError(emailInput, emailError, problem);
    if (problem) {
      showSummary(summary, problem);
      return;
    }
    email = value;
    if (!(await sendCode(byId<HTMLButtonElement>(doc, "send-code")))) return;
    byId(doc, "code-sent").textContent = messages.codeSent(email);
    emailForm.hidden = true;
    codeForm.hidden = false;
    codeInput.value = "";
    codeInput.focus();
  });

  codeForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    hideSummary(summary);
    const otp = codeInput.value.replace(/\s/g, "");
    if (!CODE_PATTERN.test(otp)) {
      setFieldError(codeInput, codeError, messages.codeRequired);
      showSummary(summary, messages.codeRequired);
      return;
    }
    const response = await whileBusy(byId<HTMLButtonElement>(doc, "verify-code"), () =>
      api.post("/sign-in/email-otp", withQuery({ email, otp })),
    );
    if (response.status === 200) {
      setFieldError(codeInput, codeError, undefined);
      announce(status, messages.redirecting);
      location.assign(field(response.body, "url") ?? afterSignIn);
      return;
    }
    if (response.status === 400 || response.status === 403) {
      setFieldError(codeInput, codeError, messages.codeInvalid);
      showSummary(summary, messages.codeInvalid);
      return;
    }
    failed(response.status);
  });

  byId<HTMLButtonElement>(doc, "resend-code").addEventListener("click", async (event) => {
    hideSummary(summary);
    if (await sendCode(event.currentTarget as HTMLButtonElement)) {
      announce(status, messages.codeResent);
    }
  });

  byId<HTMLButtonElement>(doc, "change-email").addEventListener("click", () => {
    hideSummary(summary);
    codeForm.hidden = true;
    emailForm.hidden = false;
    emailInput.focus();
  });

  const signedIn = byId(doc, "signed-in");
  byId<HTMLButtonElement>(doc, "sign-out").addEventListener("click", async (event) => {
    const button = event.currentTarget as HTMLButtonElement;
    const response = await whileBusy(button, () => api.post("/sign-out", {}));
    if (response.status === 200) {
      signedIn.hidden = true;
      signIn.hidden = false;
      announce(status, messages.signedOut);
    } else {
      failed(response.status);
    }
  });

  for (const button of doc.querySelectorAll<HTMLButtonElement>("button[data-link-provider]")) {
    button.addEventListener("click", async () => {
      hideSummary(summary);
      const provider = button.dataset.linkProvider ?? "";
      const response = await whileBusy(button, () =>
        api.post("/link-social", {
          provider,
          callbackURL: `/login?linked=${provider}`,
          errorCallbackURL: "/login",
        }),
      );
      const url = field(response.body, "url");
      if (response.status === 200 && url) {
        announce(status, messages.redirecting);
        location.assign(url);
      } else {
        failed(response.status);
      }
    });
  }

  // An OAuth client asked for a sign-in: always offer it, even with a session.
  const sessionEmail = oauthQuery ? undefined : await currentUserEmail(api);
  if (sessionEmail && next) {
    location.assign(next);
    return;
  }
  if (sessionEmail) {
    byId(doc, "signed-in-email").textContent = messages.signedInAs(sessionEmail);
    signedIn.hidden = false;
    await showMethods(doc, api);
    const linked = new URLSearchParams(location.search).get("linked");
    if (linked && !providerError) announce(status, messages.providerLinked(linked));
    return;
  }
  signIn.hidden = false;
}

/** Marks each provider as connected, or offers to connect it. */
async function showMethods(doc: Document, api: Api): Promise<void> {
  const response = await api.get("/list-accounts");
  if (response.status !== 200 || !Array.isArray(response.body)) return;
  const connected = new Set(response.body.map((account: unknown) => field(account, "providerId")));
  for (const button of doc.querySelectorAll<HTMLButtonElement>("button[data-link-provider]")) {
    const provider = button.dataset.linkProvider ?? "";
    const isConnected = connected.has(provider);
    byId(doc, `method-${provider}-connected`).hidden = !isConnected;
    button.hidden = isConnected;
  }
}
