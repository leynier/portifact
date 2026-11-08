import "../main.css";
import { HUMAN_CHECK_ACTIONS } from "@portifact/contracts/human-check";
import { browserApi } from "../auth/api.ts";
import { setupLogin } from "../auth/login.ts";
import { turnstileWidget } from "../human-check/turnstile.ts";

void setupLogin(document, {
  api: browserApi((input, init) => fetch(input, init)),
  location: window.location,
  origin: window.location.origin,
  humanCheck: turnstileWidget(document, HUMAN_CHECK_ACTIONS.signUp),
});
