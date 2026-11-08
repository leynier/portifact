import "../main.css";
import { browserApi } from "../auth/api.ts";
import { setupDevice } from "../auth/device.ts";

void setupDevice(document, {
  api: browserApi((input, init) => fetch(input, init)),
  location: window.location,
  origin: window.location.origin,
});
