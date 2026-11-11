// The login page: Google, GitHub or an email code. When an OAuth client sent the user here,
// the signed authorization request goes back with the sign-in, and Better Auth continues to
// the consent page.
//
// Terms (docs/legal.md, "Acceptance at sign-in"): the page shows a notice right above the
// methods that continuing means the user is 18 or older and accepts the Terms and the Acceptable
// Use Policy and has read the Privacy Policy. Choosing a method is the acceptance: the page
// records it with /accept-terms before the method starts, and the Worker refuses to create an
// account or a session without it.
//
// Single sign-on (decision 0016): when the email entered belongs to a domain a workspace signs in
// with its own identity provider, the page offers "Continue with single sign-on" (or an email
// code instead) and swaps the notice for the one that names it, so the same sign-in-wrap applies.
// The lookup says only whether the domain uses single sign-on, never which workspace. While the
// Worker has it switched off the lookup answers 404 and the page sends a code as before.
//
// Human check (docs/security.md, "Human check"): new accounts need a solved Turnstile challenge.
// It runs invisibly from page load (human-gate.ts) and appears below the methods only when
// Cloudflare needs an interaction; existing accounts sign in without it.
import { EMAIL_SUPPRESSED } from "@portifact/contracts/email-delivery";
import { HUMAN_VERIFICATION_REQUIRED } from "@portifact/contracts/human-check";
import { TERMS_NOT_ACCEPTED, TERMS_VERSION } from "@portifact/contracts/terms-version";
import type { HumanCheckWidget } from "../human-check/turnstile.ts";
import { type Api, currentUser, type FetchLike, field, type PageLocation } from "./api.ts";
import { announce, byId, hideSummary, setFieldError, showSummary, whileBusy } from "./dom.ts";
import { humanGate } from "./human-gate.ts";
import { messages } from "./messages.ts";
import { safeNext, signedOAuthQuery } from "./query.ts";

export interface PageEnv {
  api: Api;
  location: PageLocation;
  /** This page's origin, for example https://app.portifact.com. */
  origin: string;
  /** The human check of new accounts; null or absent when the page has no site key. */
  humanCheck?: HumanCheckWidget | null;
  /** Same-origin calls outside /api/auth (the read entry's confirmation); `fetch` by default. */
  fetch?: FetchLike;
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const CODE_PATTERN = /^\d{6}$/;
const PROVIDERS = ["google", "github"] as const;
const ACCEPTANCE = { version: TERMS_VERSION, acceptTerms: true, confirmAdult: true };
/** The Worker sends one code per address a minute (OTP_LIMITS.perEmailCooldown). */
export const RESEND_COOLDOWN_SECONDS = 60;

export async function setupLogin(doc: Document, env: PageEnv): Promise<void> {
  const { api, location } = env;
  const oauthQuery = signedOAuthQuery(location.search);
  const next = safeNext(location.search, env.origin);
  // Without a `next`, a sign-in opens the dashboard.
  const afterSignIn = next ?? "/";

  const summary = byId(doc, "error-summary");
  const status = byId(doc, "status");
  const signIn = byId(doc, "sign-in");
  const methods = byId(doc, "methods");
  const emailForm = byId<HTMLFormElement>(doc, "email-form");
  const emailInput = byId<HTMLInputElement>(doc, "email");
  const emailError = byId(doc, "email-error");
  const codeForm = byId<HTMLFormElement>(doc, "code-form");
  const codeInput = byId<HTMLInputElement>(doc, "code");
  const codeError = byId(doc, "code-error");
  const resend = byId<HTMLButtonElement>(doc, "resend-code");
  const ssoStep = byId(doc, "sso-step");
  const notice = byId(doc, "terms-notice");
  const ssoNotice = byId(doc, "terms-notice-sso");

  const providerError = new URLSearchParams(location.search).get("error");
  if (providerError) {
    showSummary(summary, messages.providerErrors[providerError] ?? messages.providerErrorFallback);
  }
  // A workspace's maximum session age asked for a new sign-in (decision 0021): sign in again
  // although a session exists, alongside it, and go back to `next`. The old session is not ended.
  const reauth = new URLSearchParams(location.search).get("reauth") === "session_age";
  if (reauth) {
    showSummary(summary, messages.providerErrors.session_age ?? messages.providerErrorFallback);
  }

  const humanCopy = byId(doc, "human-check-copy");
  const humanGroup = byId(doc, "human-check");
  const human = humanGate(env.humanCheck, {
    container: byId(doc, "human-check-widget"),
    setInteractive(visible) {
      if (visible === !humanCopy.hidden) return;
      humanCopy.hidden = !visible;
      humanGroup.classList.toggle("mt-6", visible);
      if (visible) {
        announce(status, messages.humanCheckNeeded);
        humanGroup.scrollIntoView?.({ block: "nearest" });
      }
    },
  });

  /**
   * Choosing a method accepts the terms: record it, then hand a solved check, if any, to the
   * Worker, which keeps it in a cookie for the sign-in. A missing or refused check never stops a
   * sign-in here; the Worker refuses only a new account without one.
   */
  const beforeSignIn = async () => {
    const accepted = await api.post("/accept-terms", ACCEPTANCE);
    if (accepted.status !== 200) return accepted;
    const token = await human.take();
    if (token !== undefined) await api.post("/verify-human", { token });
    return accepted;
  };

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

  // One sign-in at a time: a second method chosen while one is starting is ignored.
  let pending = false;
  const exclusive = async <T>(button: HTMLButtonElement, work: () => Promise<T>) => {
    if (pending) return undefined;
    pending = true;
    try {
      return await whileBusy(button, work);
    } finally {
      pending = false;
    }
  };

  for (const button of doc.querySelectorAll<HTMLButtonElement>("button[data-provider]")) {
    button.addEventListener("click", async () => {
      hideSummary(summary);
      const response = await exclusive(button, async () => {
        const accepted = await beforeSignIn();
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
      if (!response) return;
      const url = field(response.body, "url");
      if (response.status === 200 && url) {
        announce(status, messages.redirecting);
        location.assign(url);
      } else {
        failed(response.status);
      }
    });
  }

  // The resend link waits out the Worker's one-code-a-minute limit, counting down in its label.
  let countdown: ReturnType<typeof setInterval> | undefined;
  const startCooldown = () => {
    clearInterval(countdown);
    let left = RESEND_COOLDOWN_SECONDS;
    const tick = () => {
      if (left <= 0) {
        clearInterval(countdown);
        resend.disabled = false;
        resend.textContent = messages.resendCode;
        return;
      }
      resend.disabled = true;
      resend.textContent = messages.resendIn(left);
      left -= 1;
    };
    tick();
    countdown = setInterval(tick, 1_000);
  };

  let email = "";
  const sendCode = async (button: HTMLButtonElement): Promise<boolean | undefined> => {
    // The acceptance is renewed with every code, so it outlives the code it goes with.
    const response = await exclusive(button, async () => {
      const accepted = await beforeSignIn();
      if (accepted.status !== 200) return accepted;
      return api.post("/email-otp/send-verification-otp", { email, type: "sign-in" });
    });
    if (!response) return undefined;
    if (response.status === 200) {
      startCooldown();
      return true;
    }
    const body = response.body as { error?: unknown } | null;
    const refusal = field(body?.error, "code");
    if (refusal === EMAIL_SUPPRESSED) showSummary(summary, messages.emailSuppressed);
    else if (refusal === "capacity_unavailable") showSummary(summary, messages.emailCapacity);
    else failed(response.status);
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
      emailInput.focus();
      return;
    }
    email = value;
    const sendButton = byId<HTMLButtonElement>(doc, "send-code");
    if (await exclusive(sendButton, () => usesSso(api, email))) {
      showSso(true);
      return;
    }
    await codeStep(sendButton);
  });

  /** Sends a code and shows the code step; false when the code was not sent. */
  const codeStep = async (button: HTMLButtonElement) => {
    if (!(await sendCode(button))) return false;
    byId(doc, "code-sent").textContent = messages.codeSent(email);
    methods.hidden = true;
    ssoStep.hidden = true;
    codeForm.hidden = false;
    codeInput.value = "";
    setFieldError(codeInput, codeError, undefined);
    announce(status, messages.codeSentStatus);
    codeInput.focus();
    return true;
  };

  /** Shows or hides the single sign-on step, with the notice that names it. */
  const showSso = (shown: boolean) => {
    ssoStep.hidden = !shown;
    methods.hidden = shown;
    notice.hidden = shown;
    ssoNotice.hidden = !shown;
    if (!shown) return;
    byId(doc, "sso-for").textContent = messages.ssoFor(email);
    announce(status, messages.ssoShown);
    byId(doc, "sso-heading").focus();
  };

  byId<HTMLButtonElement>(doc, "sso-continue").addEventListener("click", async (event) => {
    hideSummary(summary);
    const response = await exclusive(event.currentTarget as HTMLButtonElement, async () => {
      const accepted = await beforeSignIn();
      if (accepted.status !== 200) return accepted;
      return api.post("/sign-in/sso", {
        email,
        callbackURL: afterSignIn,
        errorCallbackURL: "/login",
      });
    });
    if (!response) return;
    const url = field(response.body, "url");
    if (response.status === 200 && url) {
      announce(status, messages.redirecting);
      location.assign(url);
      return;
    }
    const refusal = field(response.body, "code");
    if (refusal && messages.providerErrors[refusal]) {
      showSummary(summary, messages.providerErrors[refusal]);
    } else {
      failed(response.status);
    }
  });

  byId<HTMLButtonElement>(doc, "sso-code").addEventListener("click", async (event) => {
    hideSummary(summary);
    if (await codeStep(event.currentTarget as HTMLButtonElement)) {
      notice.hidden = false;
      ssoNotice.hidden = true;
    }
  });

  byId<HTMLButtonElement>(doc, "sso-change-email").addEventListener("click", () => {
    hideSummary(summary);
    showSso(false);
    emailInput.focus();
  });

  codeForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    hideSummary(summary);
    const otp = codeInput.value.replace(/\s/g, "");
    if (!CODE_PATTERN.test(otp)) {
      setFieldError(codeInput, codeError, messages.codeRequired);
      codeInput.focus();
      return;
    }
    const response = await exclusive(byId<HTMLButtonElement>(doc, "verify-code"), () =>
      api.post("/sign-in/email-otp", withQuery({ email, otp })),
    );
    if (!response) return;
    if (response.status === 200) {
      setFieldError(codeInput, codeError, undefined);
      announce(status, messages.redirecting);
      location.assign(field(response.body, "url") ?? afterSignIn);
      return;
    }
    const refusal = field(response.body, "code");
    if (refusal === TERMS_NOT_ACCEPTED || refusal === HUMAN_VERIFICATION_REQUIRED) {
      showSummary(summary, messages.providerErrors[refusal] ?? messages.providerErrorFallback);
      return;
    }
    if (response.status === 400 || response.status === 403) {
      setFieldError(codeInput, codeError, messages.codeInvalid);
      codeInput.focus();
      return;
    }
    failed(response.status);
  });

  resend.addEventListener("click", async () => {
    hideSummary(summary);
    if (await sendCode(resend)) announce(status, messages.codeResent);
  });

  byId<HTMLButtonElement>(doc, "change-email").addEventListener("click", () => {
    hideSummary(summary);
    codeForm.hidden = true;
    showSso(false);
    emailInput.focus();
  });

  const showSignIn = () => {
    signIn.hidden = false;
    human.prepare();
  };

  const signedIn = byId(doc, "signed-in");
  byId<HTMLButtonElement>(doc, "sign-out").addEventListener("click", async (event) => {
    const button = event.currentTarget as HTMLButtonElement;
    const response = await whileBusy(button, () => api.post("/sign-out", {}));
    if (response.status === 200) {
      signedIn.hidden = true;
      byId(doc, "intro").hidden = false;
      showSignIn();
      announce(status, messages.signedOut);
    } else {
      failed(response.status);
    }
  });

  // An OAuth client asked for a sign-in: always offer it, even with a session.
  const user = oauthQuery ? undefined : await currentUser(api);
  if (user && user.termsVersion !== TERMS_VERSION) {
    setupTermsUpdate(doc, env, { email: user.email, afterSignIn, summary, showSignIn });
    return;
  }
  const sessionEmail = user?.email;
  const confirming = new URLSearchParams(location.search).get("confirm") === "read";
  if (confirming) {
    const entry = next ? readEntry(next) : undefined;
    if (!entry) {
      showSummary(summary, messages.readConfirm.missing);
      return;
    }
    if (sessionEmail) {
      setupReadConfirm(doc, env, { email: sessionEmail, entry, summary });
      return;
    }
  }
  if (reauth) {
    showSignIn();
    return;
  }
  if (sessionEmail && next) {
    location.assign(next);
    return;
  }
  if (sessionEmail) {
    byId(doc, "intro").hidden = true;
    byId(doc, "signed-in-email").textContent = messages.signedInAs(sessionEmail);
    signedIn.hidden = false;
    await showMethods(doc, api);
    await offerSsoLink(doc, env, { email: sessionEmail, summary, failed });
    return;
  }
  showSignIn();
}

/**
 * A signed-in account whose address uses single sign-on links it here once (decision 0016,
 * section 3): the flow starts from this session, and the callback links the identity to this
 * account only. The account already accepted the current terms, or this page would review them.
 */
async function offerSsoLink(
  doc: Document,
  env: PageEnv,
  link: { email: string; summary: HTMLElement; failed: (status: number) => void },
): Promise<void> {
  if (!(await usesSso(env.api, link.email))) return;
  byId(doc, "sso-link-group").hidden = false;
  const button = byId<HTMLButtonElement>(doc, "sso-link");
  button.addEventListener("click", async () => {
    hideSummary(link.summary);
    const response = await whileBusy(button, () =>
      env.api.post("/sign-in/sso", {
        email: link.email,
        callbackURL: "/",
        errorCallbackURL: "/login",
      }),
    );
    const url = field(response.body, "url");
    if (response.status === 200 && url) {
      env.location.assign(url);
      return;
    }
    const refusal = field(response.body, "code");
    if (refusal && messages.providerErrors[refusal]) {
      showSummary(link.summary, messages.providerErrors[refusal]);
    } else {
      link.failed(response.status);
    }
  });
}

/** Whether the address signs in through a workspace's identity provider; false on any failure. */
async function usesSso(api: Api, email: string): Promise<boolean> {
  const response = await api.post("/sso/lookup", { email });
  if (response.status !== 200 || typeof response.body !== "object" || response.body === null) {
    return false;
  }
  return (response.body as { sso?: unknown }).sso === true;
}

interface ReadEntry {
  id: string;
  state: string;
  host: string;
}

/** The artifact, nonce and custom host of a read entry path, or undefined. */
function readEntry(path: string): ReadEntry | undefined {
  const url = new URL(path, "https://app.invalid");
  const match = /^\/read\/([a-z2-7]{10})$/.exec(url.pathname);
  const state = url.searchParams.getAll("state");
  const host = url.searchParams.getAll("host");
  if (!match || state.length !== 1 || host.length !== 1) return undefined;
  if (!STATE_SHAPE.test(state[0] as string) || !hostShaped(host[0] as string)) return undefined;
  return { id: match[1] as string, state: state[0] as string, host: host[0] as string };
}

/** The sign-in transaction's state: 32 random bytes in base64url (`OpaqueToken` in contracts). */
const STATE_SHAPE = /^[A-Za-z0-9_-]{43}$/;
const HOST_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/**
 * Whether the text is shaped like a lowercase host name of two or more labels. The page shows it
 * next to the visitor's email before the server has checked it against the artifact's own
 * address, so anything else in its place would be a message from whoever built the link.
 */
function hostShaped(host: string): boolean {
  if (host.length === 0 || host.length > 253) return false;
  const labels = host.split(".");
  return labels.length >= 2 && labels.every((label) => HOST_LABEL.test(label));
}

/**
 * The read entry's confirmation (decision 0006, "Codes on a custom host"): an artifact that every
 * signed-in account reads opens on its owner's own address only after this click, which sends the
 * entry as a same-origin POST; the answer says where to go.
 */
function setupReadConfirm(
  doc: Document,
  env: PageEnv,
  confirm: { email: string; entry: ReadEntry; summary: HTMLElement },
): void {
  const { entry, summary } = confirm;
  const send = env.fetch ?? ((input, init) => fetch(input, init));
  // Built from a template only now, so the page has no empty heading or button before it.
  const template = byId<HTMLTemplateElement>(doc, "read-confirm-template");
  template.after(template.content.cloneNode(true));
  const heading = doc.createElement("h2");
  heading.id = "read-confirm-heading";
  heading.className = "text-lg font-semibold";
  heading.textContent = messages.readConfirm.heading;
  byId(doc, "read-confirm").prepend(heading);
  byId(doc, "intro").hidden = true;
  byId(doc, "read-confirm-email").textContent = messages.signedInAs(confirm.email);
  byId(doc, "read-confirm-body").textContent = messages.readConfirm.body(entry.host);
  const button = byId<HTMLButtonElement>(doc, "read-confirm-continue");
  button.textContent = messages.readConfirm.continue;
  button.addEventListener("click", async () => {
    hideSummary(summary);
    const url = await whileBusy(button, async () => {
      try {
        const response = await send(`/read/${entry.id}`, {
          method: "POST",
          credentials: "same-origin",
          headers: { "content-type": "application/json", accept: "application/json" },
          body: JSON.stringify({ state: entry.state, host: entry.host }),
        });
        return response.ok ? field(await response.json(), "url") : undefined;
      } catch {
        return undefined;
      }
    });
    if (url) {
      env.location.assign(url);
    } else {
      showSummary(summary, messages.unexpected);
    }
  });
}

interface TermsUpdate {
  email: string;
  afterSignIn: string;
  summary: HTMLElement;
  showSignIn(): void;
}

/**
 * A signed-in account that has not accepted the current terms (an account from before they
 * existed, or after they changed) accepts them here before going on, or signs out. The notice
 * above the button says that selecting it is the acceptance.
 */
function setupTermsUpdate(doc: Document, env: PageEnv, update: TermsUpdate): void {
  const { api, location } = env;
  const { summary } = update;
  const section = byId(doc, "terms-update");
  const status = byId(doc, "status");
  byId(doc, "intro").hidden = true;
  byId(doc, "terms-update-email").textContent = messages.termsUpdateFor(update.email);

  const failed = (statusCode: number) =>
    showSummary(summary, statusCode === 0 ? messages.network : messages.unexpected);

  byId<HTMLButtonElement>(doc, "terms-update-continue").addEventListener("click", async (event) => {
    hideSummary(summary);
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
      byId(doc, "intro").hidden = false;
      update.showSignIn();
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
