// The login page: Google, GitHub or an email code. When an OAuth client sent the user here,
// the signed authorization request goes back with the sign-in, and Better Auth continues to
// the consent page. Every method first records that the user accepts the terms and is 18 or
// older; the Worker refuses to create an account or a session without it (docs/legal.md).
import { TERMS_NOT_ACCEPTED, TERMS_VERSION } from "@portifact/contracts/terms-version";
import { type Api, currentUser, field, type PageLocation } from "./api.ts";
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
const PROVIDERS = ["google", "github"] as const;
const ACCEPTANCE = { version: TERMS_VERSION, acceptTerms: true, confirmAdult: true };

export async function setupLogin(doc: Document, env: PageEnv): Promise<void> {
  const { api, location } = env;
  const oauthQuery = signedOAuthQuery(location.search);
  const next = safeNext(location.search, env.origin);
  // Without a `next`, a sign-in opens the dashboard.
  const afterSignIn = next ?? "/";

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

  const termsBox = byId<HTMLInputElement>(doc, "terms-accept");
  const termsError = byId(doc, "terms-accept-error");

  /** The terms box must be checked; otherwise the error is shown and false returned. */
  const termsChecked = (box: HTMLInputElement, error: HTMLElement): boolean => {
    const problem = box.checked ? undefined : messages.termsRequired;
    setFieldError(box, error, problem);
    if (problem) showSummary(summary, problem);
    return !problem;
  };

  const acceptTerms = () => api.post("/accept-terms", ACCEPTANCE);

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
      if (!termsChecked(termsBox, termsError)) return;
      const response = await whileBusy(button, async () => {
        const accepted = await acceptTerms();
        if (accepted.status !== 200) return accepted;
        return api.post(
          "/sign-in/social",
          withQuery({
            provider: button.dataset.provider,
            callbackURL: afterSignIn,
            errorCallbackURL: "/login",
          }),
        );
      });
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
    // The acceptance is renewed with every code, so it outlives the code it goes with.
    const response = await whileBusy(button, async () => {
      const accepted = await acceptTerms();
      if (accepted.status !== 200) return accepted;
      return api.post("/email-otp/send-verification-otp", { email, type: "sign-in" });
    });
    if (response.status === 200) return true;
    failed(response.status);
    return false;
  };

  emailForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    hideSummary(summary);
    if (!termsChecked(termsBox, termsError)) return;
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
    if (field(response.body, "code") === TERMS_NOT_ACCEPTED) {
      showSummary(summary, messages.providerErrors[TERMS_NOT_ACCEPTED] ?? messages.termsRequired);
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

  // An OAuth client asked for a sign-in: always offer it, even with a session.
  const user = oauthQuery ? undefined : await currentUser(api);
  if (user && user.termsVersion !== TERMS_VERSION) {
    setupTermsUpdate(doc, env, { email: user.email, afterSignIn, summary, signIn, termsChecked });
    return;
  }
  const sessionEmail = user?.email;
  if (sessionEmail && next) {
    location.assign(next);
    return;
  }
  if (sessionEmail) {
    byId(doc, "signed-in-email").textContent = messages.signedInAs(sessionEmail);
    signedIn.hidden = false;
    await showMethods(doc, api);
    return;
  }
  signIn.hidden = false;
}

interface TermsUpdate {
  email: string;
  afterSignIn: string;
  summary: HTMLElement;
  signIn: HTMLElement;
  termsChecked: (box: HTMLInputElement, error: HTMLElement) => boolean;
}

/**
 * A signed-in account that has not accepted the current terms (an account from before they
 * existed, or after they changed) accepts them here before going on, or signs out.
 */
function setupTermsUpdate(doc: Document, env: PageEnv, update: TermsUpdate): void {
  const { api, location } = env;
  const { summary } = update;
  const section = byId(doc, "terms-update");
  const box = byId<HTMLInputElement>(doc, "terms-update-accept");
  const error = byId(doc, "terms-update-accept-error");
  const status = byId(doc, "status");
  byId(doc, "terms-update-email").textContent = messages.termsUpdateFor(update.email);

  const failed = (statusCode: number) =>
    showSummary(summary, statusCode === 0 ? messages.network : messages.unexpected);

  byId<HTMLButtonElement>(doc, "terms-update-continue").addEventListener("click", async (event) => {
    hideSummary(summary);
    if (!update.termsChecked(box, error)) return;
    const response = await whileBusy(event.currentTarget as HTMLButtonElement, () =>
      api.post("/accept-terms", ACCEPTANCE),
    );
    if (response.status === 200) {
      announce(status, messages.redirecting);
      location.assign(update.afterSignIn);
    } else {
      failed(response.status);
    }
  });

  byId<HTMLButtonElement>(doc, "terms-update-sign-out").addEventListener("click", async (event) => {
    hideSummary(summary);
    const response = await whileBusy(event.currentTarget as HTMLButtonElement, () =>
      api.post("/sign-out", {}),
    );
    if (response.status === 200) {
      section.hidden = true;
      update.signIn.hidden = false;
      announce(status, messages.signedOut);
    } else {
      failed(response.status);
    }
  });

  section.hidden = false;
}

/** Shows which providers already sign in to this account. */
async function showMethods(doc: Document, api: Api): Promise<void> {
  const response = await api.get("/list-accounts");
  if (response.status !== 200 || !Array.isArray(response.body)) return;
  const connected = new Set(response.body.map((account: unknown) => field(account, "providerId")));
  for (const provider of PROVIDERS) {
    byId(doc, `method-${provider}`).textContent = connected.has(provider)
      ? messages.methodConnected
      : messages.methodNotUsed;
  }
}
