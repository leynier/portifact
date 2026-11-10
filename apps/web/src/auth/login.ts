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

  const providerError = new URLSearchParams(location.search).get("error");
  if (providerError) {
    showSummary(summary, messages.providerErrors[providerError] ?? messages.providerErrorFallback);
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
    if (!(await sendCode(byId<HTMLButtonElement>(doc, "send-code")))) return;
    byId(doc, "code-sent").textContent = messages.codeSent(email);
    methods.hidden = true;
    codeForm.hidden = false;
    codeInput.value = "";
    setFieldError(codeInput, codeError, undefined);
    announce(status, messages.codeSentStatus);
    codeInput.focus();
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
    methods.hidden = false;
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
  if (sessionEmail && next) {
    location.assign(next);
    return;
  }
  if (sessionEmail) {
    byId(doc, "intro").hidden = true;
    byId(doc, "signed-in-email").textContent = messages.signedInAs(sessionEmail);
    signedIn.hidden = false;
    await showMethods(doc, api);
    return;
  }
  showSignIn();
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
  return { id: match[1] as string, state: state[0] as string, host: host[0] as string };
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
