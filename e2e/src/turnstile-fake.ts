// A stand-in for Cloudflare Turnstile's script, served by the test front end at the real script
// URL (the proxy maps challenges.cloudflare.com to it), so the login page runs its human check
// exactly as in production, CSP included, without leaving the machine. The e2e Worker's fake
// siteverify (worker/index.ts) accepts only TURNSTILE_PASS.
//
// A test picks the challenge with the `e2e_turnstile` cookie on the app host:
// - absent: solved invisibly after a short delay, as most visitors experience it;
// - `interactive`: asks for an interaction, a checkbox in the widget's container;
// - `fail`: the challenge errors, as when the script is blocked.
export const TURNSTILE_HOST = "challenges.cloudflare.com";
export const TURNSTILE_SCRIPT_PATH = "/turnstile/v0/api.js";
export const TURNSTILE_PASS = "e2e-turnstile-pass";
export const TURNSTILE_MODE_COOKIE = "e2e_turnstile";

export const FAKE_TURNSTILE_SCRIPT = `(() => {
  const widgets = new Map();
  let next = 0;
  const mode = () => {
    const match = document.cookie.match(/(?:^|; )${TURNSTILE_MODE_COOKIE}=([^;]+)/);
    return match ? match[1] : "invisible";
  };
  const call = (options, name, value) => {
    const callback = options[name];
    if (typeof callback === "function") callback(value);
  };
  window.turnstile = {
    render(container, options) {
      const id = "e2e-widget-" + (next += 1);
      const root = document.createElement("div");
      root.dataset.e2eTurnstile = id;
      container.append(root);
      widgets.set(id, root);
      const current = mode();
      setTimeout(() => {
        if (!widgets.has(id)) return;
        if (current === "fail") return call(options, "error-callback", "110200");
        if (current === "interactive") {
          call(options, "before-interactive-callback");
          const label = document.createElement("label");
          const box = document.createElement("input");
          box.type = "checkbox";
          label.append(box, " Verify you are human");
          box.addEventListener("change", () => {
            box.disabled = true;
            label.append(" (verified)");
            call(options, "after-interactive-callback");
            call(options, "callback", "${TURNSTILE_PASS}");
          });
          root.append(label);
          return;
        }
        if (options.appearance !== "interaction-only") root.textContent = "Success";
        call(options, "callback", "${TURNSTILE_PASS}");
      }, 300);
      return id;
    },
    remove(id) {
      widgets.get(id)?.remove();
      widgets.delete(id);
    },
  };
})();
`;
