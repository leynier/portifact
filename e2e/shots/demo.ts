// Example content for the landing page's screenshots and transcripts. The people and products are
// made up (example.com addresses), and the copy matches what the landing says around each image.

/** Shared look of the example artifacts: their own colors, light and dark, like any user page. */
const STYLE = `
:root { color-scheme: light dark; --ink: #18181b; --muted: #5f5f66; --line: #e4e4e7; --soft: #f4f4f5; --page: #ffffff; --accent: #18181b; }
@media (prefers-color-scheme: dark) { :root { --ink: #f4f4f5; --muted: #a1a1aa; --line: #34343a; --soft: #1f1f23; --page: #121214; --accent: #f4f4f5; } }
* { box-sizing: border-box; }
body { margin: 0; background: var(--page); color: var(--ink); font: 16px/1.6 ui-sans-serif, system-ui, sans-serif; }
`;

export const REPORT_QUOTE = "Writes switch over only after seven days without errors.";

export const REPORT_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Billing migration, week 32</title>
<style>${STYLE}
main { max-width: 760px; margin: 0 auto; padding: 48px 32px 64px; }
.eyebrow { font: 600 12px/1 ui-monospace, monospace; letter-spacing: .12em; text-transform: uppercase; color: var(--muted); }
h1 { font-size: 32px; line-height: 1.15; margin: 12px 0 8px; letter-spacing: -.02em; }
.lede { color: var(--muted); margin: 0 0 28px; }
.stats { display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; margin-bottom: 20px; }
.stat { border: 1px solid var(--line); border-radius: 10px; padding: 14px 16px; }
.stat span { display: block; font-size: 13px; color: var(--muted); }
.stat strong { font-size: 22px; }
.bar { height: 8px; border-radius: 99px; background: var(--soft); overflow: hidden; margin-bottom: 32px; }
.bar div { width: 75%; height: 100%; background: var(--accent); }
h2 { font-size: 18px; margin: 28px 0 8px; }
p { margin: 0 0 14px; }
</style>
</head>
<body>
<main>
<p class="eyebrow">Progress report · Week 32</p>
<h1>Billing migration</h1>
<p class="lede">Moving invoices and payments to the new billing cluster.</p>
<div class="stats">
<div class="stat"><span>Endpoints moved</span><strong>18 of 24</strong></div>
<div class="stat"><span>Error rate</span><strong>0.02%</strong></div>
<div class="stat"><span>Rollback</span><strong>Ready</strong></div>
</div>
<div class="bar"><div></div></div>
<h2>Where we are</h2>
<p>Read traffic now runs on the new cluster behind a flag, with automatic rollback. ${REPORT_QUOTE} Until then, every write goes to both clusters and a nightly job compares them.</p>
<h2>Next week</h2>
<p>Move the six remaining endpoints, starting with refunds and credit notes, and turn on alerts for the comparison job.</p>
</main>
</body>
</html>
`;

export const CHECKOUT_SENTENCE = "Free returns for 30 days. Delivery in 3 to 5 business days.";
export const CHECKOUT_INNER = "3 to 5 business days";
export const CHECKOUT_SHIPPING = "Shipping";

export const PROTOTYPE: Record<string, string> = {
  "index.html": `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Checkout</title>
<link rel="stylesheet" href="styles.css">
</head>
<body>
<main class="checkout">
<p class="step">Step 3 of 3</p>
<h1>Checkout</h1>
<ul class="lines">
<li><span>Wool sweater, size M</span><span>$42.00</span></li>
<li><span>${CHECKOUT_SHIPPING}</span><span>$6.00</span></li>
<li class="total"><span>Total</span><span>$48.00</span></li>
</ul>
<p class="note">${CHECKOUT_SENTENCE}</p>
<button type="button" id="order">Place order</button>
<p class="secure">Payments are processed securely.</p>
</main>
<script src="app.js"></script>
</body>
</html>
`,
  "styles.css": `${STYLE}
body { background: var(--soft); }
.checkout { max-width: 420px; margin: 40px auto; padding: 28px; background: var(--page); border: 1px solid var(--line); border-radius: 14px; }
.step { margin: 0; font-size: 13px; color: var(--muted); }
h1 { margin: 4px 0 20px; font-size: 26px; letter-spacing: -.02em; }
.lines { list-style: none; margin: 0 0 20px; padding: 0; }
.lines li { display: flex; justify-content: space-between; padding: 8px 0; color: var(--muted); }
.lines li span:last-child { color: var(--ink); }
.lines .total { border-top: 1px solid var(--line); margin-top: 4px; padding-top: 12px; font-weight: 700; color: var(--ink); }
.note { color: var(--muted); margin: 0 0 20px; }
button { width: 100%; padding: 12px; border: 0; border-radius: 8px; background: var(--accent); color: var(--page); font: 600 16px system-ui, sans-serif; }
.secure { margin: 12px 0 0; text-align: center; font-size: 13px; color: var(--muted); }
`,
  "app.js": `document.getElementById("order").addEventListener("click", (event) => {
  event.currentTarget.textContent = "Order placed";
});
`,
};

export const PLAN_MD = `# API design plan

A versioned REST API for invoices and payments, replacing the internal RPC calls.

## Resources

- \`/v1/invoices\` lists, creates and voids invoices.
- \`/v1/payments\` records payments against an invoice.

## Authentication

Clients send a bearer token from the OAuth client credentials flow. Tokens last one hour and carry the scopes of the client.

## Errors

Every error has a stable \`code\` and a human \`message\`.
`;

export const RELEASE_NOTES_TXT = `Release 2.4

- Invoices can be voided from the list.
- Payment receipts include the tax breakdown.
- Faster search across customers.
`;

export const PEOPLE = {
  owner: { email: "sam@example.com", name: "Sam Rivera" },
  ana: { email: "ana@example.com", name: "Ana Lopez" },
  marco: { email: "marco@example.com", name: "Marco Rossi" },
} as const;
