// The public report page (app.portifact.com/report): anyone can report an artifact that breaks
// the Acceptable Use Policy. `?artifact=<id>` fills the artifact, which is how the reserved
// `/__portifact/report` path of every artifact origin links here.
import type { ApiResponse, PageLocation } from "../auth/api.ts";
import { byId, hideSummary, setFieldError, showSummary, whileBusy } from "../auth/dom.ts";

export interface ReportEnv {
  /** Sends the report as JSON to `/api/v1/reports` on this origin. */
  send(body: unknown): Promise<ApiResponse>;
  location: PageLocation;
}

export const reportMessages = {
  artifactRequired: "Enter the artifact's address or ID.",
  artifactInvalid: "Enter an address like https://abcdefghij.portifact.dev/ or a 10-character ID.",
  reasonRequired: "Choose what is wrong with the artifact.",
  detailsInvalid: "Remove control characters or shorten the details.",
  emailInvalid: "Enter a valid email address, or leave it empty.",
  rateLimited: "Too many reports from here. Try again later or write to abuse@portifact.com.",
  network: "Portifact could not be reached. Check your connection and try again.",
  failed: "The report could not be sent. Try again or write to abuse@portifact.com.",
  sent: "Report sent.",
} as const;

const ID_PATTERN = /^[a-z2-7]{10}$/;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Which field a 400 answer is about, from the `field: message` the API returns. */
function invalidField(body: unknown): string | undefined {
  if (typeof body !== "object" || body === null) return undefined;
  const message = (body as { error?: { message?: unknown } }).error?.message;
  return typeof message === "string" ? message.split(":", 1)[0] : undefined;
}

export function setupReport(doc: Document, env: ReportEnv): void {
  const form = byId<HTMLFormElement>(doc, "report-form");
  const summary = byId(doc, "error-summary");
  const status = byId(doc, "status");
  const button = byId<HTMLButtonElement>(doc, "send");
  const artifact = byId<HTMLInputElement>(doc, "artifact");
  const reason = byId<HTMLSelectElement>(doc, "reason");
  const details = byId<HTMLTextAreaElement>(doc, "details");
  const email = byId<HTMLInputElement>(doc, "email");
  const errors = {
    artifact: byId(doc, "artifact-error"),
    reason: byId(doc, "reason-error"),
    details: byId(doc, "details-error"),
    email: byId(doc, "email-error"),
  };
  const inputs = { artifact, reason, details, email } as const;
  type Field = keyof typeof inputs;

  const given = new URLSearchParams(env.location.search).get("artifact")?.trim().toLowerCase();
  if (given && ID_PATTERN.test(given)) artifact.value = given;

  const clear = () => {
    for (const name of Object.keys(inputs) as Field[]) {
      setFieldError(inputs[name] as HTMLInputElement, errors[name], undefined);
    }
    hideSummary(summary);
  };
  const fail = (name: Field, message: string) => {
    setFieldError(inputs[name] as HTMLInputElement, errors[name], message);
    showSummary(summary, message);
  };

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    clear();
    const values = {
      artifact: artifact.value.trim(),
      reason: reason.value,
      details: details.value.trim(),
      email: email.value.trim(),
    };
    if (!values.artifact) return fail("artifact", reportMessages.artifactRequired);
    if (!values.reason) return fail("reason", reportMessages.reasonRequired);
    if (values.email && !EMAIL_PATTERN.test(values.email)) {
      return fail("email", reportMessages.emailInvalid);
    }
    void whileBusy(button, async () => {
      const response = await env.send({
        artifact: values.artifact,
        reason: values.reason,
        ...(values.details ? { details: values.details } : {}),
        ...(values.email ? { email: values.email } : {}),
      });
      if (response.status === 202) {
        form.hidden = true;
        const done = byId(doc, "done");
        done.hidden = false;
        status.textContent = reportMessages.sent;
        byId(doc, "done-heading").focus();
        return;
      }
      if (response.status === 0) return showSummary(summary, reportMessages.network);
      if (response.status === 429) return showSummary(summary, reportMessages.rateLimited);
      if (response.status === 400) {
        const field = invalidField(response.body);
        if (field === "details") return fail("details", reportMessages.detailsInvalid);
        if (field === "email") return fail("email", reportMessages.emailInvalid);
        if (field === "reason") return fail("reason", reportMessages.reasonRequired);
        return fail("artifact", reportMessages.artifactInvalid);
      }
      showSummary(summary, reportMessages.failed);
    });
  });
}

/** Posts JSON to the report endpoint on this origin; a network failure answers status 0. */
export function reportSender(fetchImpl: typeof fetch): (body: unknown) => Promise<ApiResponse> {
  return async (body) => {
    try {
      const response = await fetchImpl("/api/v1/reports", {
        method: "POST",
        credentials: "omit",
        headers: { accept: "application/json", "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const text = await response.text();
      let parsed: unknown = null;
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = null;
      }
      return { status: response.status, body: parsed };
    } catch {
      return { status: 0, body: null };
    }
  };
}
