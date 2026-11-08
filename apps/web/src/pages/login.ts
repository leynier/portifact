import "../main.css";
import { browserApi } from "../auth/api.ts";
import { setupLogin } from "../auth/login.ts";

void setupLogin(document, {
  api: browserApi((input, init) => fetch(input, init)),
  location: window.location,
  origin: window.location.origin,
});
