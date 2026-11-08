import "../main.css";
import { browserApi } from "../auth/api.ts";
import { setupConsent } from "../auth/consent.ts";

void setupConsent(document, {
  api: browserApi((input, init) => fetch(input, init)),
  location: window.location,
  origin: window.location.origin,
});
