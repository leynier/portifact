// Review-mode HTML: the served page with the bridge script appended, and the pages that tell the
// viewer review cannot go on. The original bytes in R2 never change; only the review response
// is rewritten, and it is never cached.

import { REVIEW_CHANNEL, REVIEW_PROTOCOL } from "@portifact/bridge";
import { BRIDGE_SCRIPT, BRIDGE_VERSION } from "@portifact/bridge/bundle";
import { DEFAULT_LOCALE, type LocaleCode, localeInfo } from "@portifact/contracts/locales";
import { negotiateLocale, parseAcceptLanguage } from "@portifact/domain/locale";
import type { ReviewStatus } from "./review.ts";

export const BRIDGE_PATH = "/__portifact/bridge.js";

const ATTRIBUTE_ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

function escapeAttribute(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ATTRIBUTE_ESCAPES[char] ?? char);
}

/** A random CSP nonce for one response. */
export function cspNonce(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return btoa(String.fromCharCode(...bytes));
}

export interface InjectOptions {
  appOrigin: string;
  /** The served file of the version, which targets refer to. */
  path: string;
  /** Tag of the review session the page is served in; the bridge echoes it to the viewer. */
  sessionTag: string;
  /**
   * For a page rendered by Portifact: the nonce the response's CSP allows the bridge with. The
   * page's own CSP `<meta>` is dropped, because the header carries the same policy plus the nonce.
   */
  nonce?: string | undefined;
}

/**
 * Appends the bridge to an HTML response. A site's own markup stays as it is, including any CSP
 * it declares; if that CSP blocks the bridge, the viewer notices the silence and offers general
 * comments.
 */
export function injectBridge(response: Response, options: InjectOptions): Response {
  let renderer: string | undefined;
  const rewriter = new HTMLRewriter();
  if (options.nonce !== undefined) {
    rewriter.on("meta[http-equiv]", {
      element(element) {
        const name = element.getAttribute("http-equiv")?.toLowerCase();
        if (name === "content-security-policy") element.remove();
      },
    });
    // The page's own report link would navigate the frame away from the review; the viewer
    // shows its own.
    rewriter.on("[data-portifact-chrome]", {
      element(element) {
        element.remove();
      },
    });
    rewriter.on('meta[name="generator"]', {
      element(element) {
        const match = /^portifact-render ([0-9A-Za-z.+-]{1,32})$/.exec(
          element.getAttribute("content") ?? "",
        );
        if (match) renderer = `portifact-render@${match[1]}`;
      },
    });
  }
  rewriter.onDocument({
    end(end) {
      const attributes = [
        `src="${BRIDGE_PATH}?v=${BRIDGE_VERSION}"`,
        `data-app-origin="${escapeAttribute(options.appOrigin)}"`,
        `data-path="${escapeAttribute(options.path)}"`,
        `data-session-tag="${escapeAttribute(options.sessionTag)}"`,
        ...(renderer ? [`data-renderer="${escapeAttribute(renderer)}"`] : []),
        ...(options.nonce !== undefined ? [`nonce="${escapeAttribute(options.nonce)}"`] : []),
      ];
      end.append(`<script ${attributes.join(" ")}></script>`, { html: true });
    },
  });
  return rewriter.transform(response);
}

/** Where the review tab's banner links to end review (see `handleReviewEnd`). */
export const REVIEW_END_HREF = "/__portifact/review/end";

const BANNER_STYLE = [
  ":host{all:initial;display:block}",
  ".bar{display:flex;flex-wrap:wrap;align-items:center;gap:8px 16px;padding:10px 16px;background:#111;color:#fff;font:15px/1.4 system-ui,sans-serif;border-bottom:2px solid #fff}",
  "p{margin:0}",
  "strong{font-weight:700}",
  "a{color:#111;background:#fff;padding:6px 12px;border-radius:4px;font-weight:700;text-decoration:none}",
  "a:hover{text-decoration:underline}",
  "a:focus-visible{outline:3px solid #fff;outline-offset:2px}",
].join("");

/** The review tab banner's text in one language. */
export interface BannerText {
  /** The banner region's accessible name. */
  region: string;
  /** The bold lead, such as "Review tab." */
  lead: string;
  /** What follows it: the version, where comments go and when the review ends by itself. */
  body(minutes: number): string;
  /** The link that ends the review. The dashboard names it in the same words. */
  end: string;
}

/**
 * The banner in every language, typed by the locale list so a new language fails the typecheck
 * until it is here. The dashboard's review-tab messages name the `end` link with the same words.
 */
export const BANNER_TEXT: { readonly [code in LocaleCode]: BannerText } = {
  en: {
    region: "Portifact review",
    lead: "Review tab.",
    body: (minutes) =>
      `You are reviewing the version shown here. Write comments in the review viewer. This review ends by itself within ${minutes} minutes.`,
    end: "End review",
  },
  es: {
    region: "Revisión de Portifact",
    lead: "Pestaña de revisión.",
    body: (minutes) =>
      `Estás revisando la versión que se muestra aquí. Escribe los comentarios en el visor de revisión. Esta revisión termina sola en ${minutes} minutos como máximo.`,
    end: "Terminar revisión",
  },
  "pt-BR": {
    region: "Revisão do Portifact",
    lead: "Aba de revisão.",
    body: (minutes) =>
      `Você está revisando a versão exibida aqui. Escreva os comentários no visualizador de revisão. Esta revisão termina sozinha em até ${minutes} minutos.`,
    end: "Encerrar revisão",
  },
  fr: {
    region: "Relecture Portifact",
    lead: "Onglet de relecture.",
    body: (minutes) =>
      `Vous relisez la version affichée ici. Écrivez vos commentaires dans la visionneuse de relecture. Cette relecture prend fin d’elle-même dans ${minutes} minutes au plus.`,
    end: "Terminer la relecture",
  },
  de: {
    region: "Portifact-Review",
    lead: "Review-Tab.",
    body: (minutes) =>
      `Du reviewst die hier angezeigte Version. Schreib Kommentare im Review-Viewer. Dieses Review endet von selbst spätestens nach ${minutes} Minuten.`,
    end: "Review beenden",
  },
  ru: {
    region: "Проверка Portifact",
    lead: "Вкладка проверки.",
    body: (minutes) =>
      `Вы проверяете показанную здесь версию. Пишите комментарии в просмотрщике. Эта проверка завершится сама не позже чем через ${minutes} мин.`,
    end: "Завершить проверку",
  },
  ja: {
    region: "Portifactのレビュー",
    lead: "レビュータブ。",
    body: (minutes) =>
      `ここに表示されているバージョンをレビューしています。コメントはレビュービューアーで書いてください。このレビューは${minutes}分以内に自動で終了します。`,
    end: "レビューを終了",
  },
  "zh-CN": {
    region: "Portifact 审阅",
    lead: "审阅标签页。",
    body: (minutes) =>
      `你正在审阅此处显示的版本。请在审阅查看器中撰写评论。此次审阅最多 ${minutes} 分钟后会自动结束。`,
    end: "结束审阅",
  },
};

/** The space after the lead, which Chinese and Japanese leave out after their full stop. */
const leadGap = (lead: string) => (lead.endsWith("。") ? "" : " ");

/**
 * The banner's language: the browser's (`Accept-Language`), since the artifact's origin knows
 * nothing else about the reader; English when none matches.
 */
export function bannerLocale(acceptLanguage: string | null): LocaleCode {
  return negotiateLocale(parseAcceptLanguage(acceptLanguage)) ?? DEFAULT_LOCALE;
}

/**
 * The review tab's banner: says the tab is in review mode, how long it lasts, where comments are
 * written, and links to end it. It is plain markup in a declarative shadow root, so the page's
 * styles do not restyle it and it needs no script; a site whose own CSP blocks inline
 * styles shows it unstyled. The page's scripts run in the same document and can hide it, which
 * is why the session is short and the viewer says how to end it too. It carries its own `lang`,
 * since the artifact's language may differ.
 */
export function reviewBanner(minutes: number, locale: LocaleCode = DEFAULT_LOCALE): string {
  const text = BANNER_TEXT[locale];
  const { code, dir } = localeInfo(locale);
  return `<div role="region" aria-label="${escapeAttribute(text.region)}" lang="${code}" dir="${dir}" data-portifact-ignore><template shadowrootmode="open"><style>${BANNER_STYLE}</style><div class="bar"><p><strong>${escapeAttribute(text.lead)}</strong>${leadGap(text.lead)}${escapeAttribute(text.body(minutes))}</p><a href="${REVIEW_END_HREF}">${escapeAttribute(text.end)}</a></div></template></div>`;
}

/**
 * Adds the review banner to an HTML response of the review tab, at the start of the body, or at
 * the end of the document when the markup has no body tag. Nothing else in the page changes.
 */
export function injectReviewBanner(
  response: Response,
  minutes: number,
  locale: LocaleCode = DEFAULT_LOCALE,
): Response {
  const banner = reviewBanner(minutes, locale);
  let placed = false;
  return new HTMLRewriter()
    .on("body", {
      element(element) {
        if (placed) return;
        placed = true;
        element.prepend(banner, { html: true });
      },
    })
    .onDocument({
      end(end) {
        if (!placed) end.append(banner, { html: true });
      },
    })
    .transform(response);
}

/** The bridge bundle. Its URL carries the bundle's version, so a matching URL is immutable. */
export function bridgeScript(request: Request): Response {
  const version = new URL(request.url).searchParams.get("v");
  return new Response(request.method === "HEAD" ? null : BRIDGE_SCRIPT, {
    headers: {
      "Content-Type": "text/javascript; charset=utf-8",
      "Cache-Control":
        version === BRIDGE_VERSION ? "public, max-age=31536000, immutable" : "no-cache",
      "Cross-Origin-Resource-Policy": "same-origin",
      "X-Content-Type-Options": "nosniff",
      "X-Robots-Tag": "noindex",
    },
  });
}

const STATUS_TEXT: Record<ReviewStatus, string> = {
  unavailable: "Review mode is not available in this browser",
  ended: "This review session has ended. Reload the review to continue",
  failed: "This review link has expired or was already used",
};

/**
 * A page that tells the viewer, and only the viewer's exact origin, why review cannot go on.
 * Its one inline script is allowed by a nonce; it posts a fixed message and reads nothing.
 */
export function reviewStatusPage(
  status: ReviewStatus,
  httpStatus: number,
  appOrigin: string,
  setCookies: string[],
): Response {
  const nonce = cspNonce();
  const message = JSON.stringify({
    channel: REVIEW_CHANNEL,
    v: REVIEW_PROTOCOL,
    type: "status",
    status,
  });
  const target = JSON.stringify(appOrigin);
  const script =
    `if (window.parent !== window) window.parent.postMessage(${message}, ${target});`.replace(
      /</g,
      "\\u003c",
    );
  const body = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Portifact</title><body><main><h1>${STATUS_TEXT[status]}</h1></main><script nonce="${nonce}">${script}</script></body></html>`;
  const headers = new Headers({
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    "X-Robots-Tag": "noindex",
    "Cross-Origin-Resource-Policy": "same-origin",
    "Content-Security-Policy": `default-src 'none'; script-src 'nonce-${nonce}'; base-uri 'none'; form-action 'none'; frame-ancestors ${appOrigin}`,
  });
  for (const cookie of setCookies) headers.append("Set-Cookie", cookie);
  return new Response(body, { status: httpStatus, headers });
}
