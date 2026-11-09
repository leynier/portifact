// The theme preference (System, Light or Dark) shared by the static pages built by apps/web and
// the CSP of the Worker that serves them. Kept free of imports, like `human-check.ts`, so pages
// and the design system can use it without bundling the schemas (`@portifact/contracts/theme`).

/**
 * The cookie shared by portifact.com and app.portifact.com that holds the chosen theme
 * (`system`, `light` or `dark`); see `@portifact/contracts/preferences`.
 */
export const THEME_COOKIE = "__Secure-pf_theme";

/**
 * Where a browser also remembers the chosen theme, per origin, for when cookies are blocked. A
 * missing value means System.
 */
export const THEME_STORAGE_KEY = "portifact.theme";

/**
 * Applies the stored theme before the first paint. apps/web inlines it at the top of every
 * page's `<head>`; the pages' CSP allows exactly this text by `THEME_SCRIPT_HASH`, so any change
 * here must update the hash (the tests say so). The shared cookie wins (an explicit `system`
 * there too), then this origin's storage. It sets `data-theme` on the root when the choice is
 * Light or Dark, and points `<picture>` sources written for a dark system theme at the chosen
 * theme while the page is parsed. Blocked cookies fall back to storage; blocked storage leaves
 * the System theme.
 */
export const THEME_SCRIPT = [
  "(function(){try{",
  "var t;",
  `try{t=("; "+document.cookie).split("; ${THEME_COOKIE}=")[1];t=t&&t.split(";")[0]}catch(e){}`,
  `if(t!=="system"&&t!=="light"&&t!=="dark")t=localStorage.getItem("${THEME_STORAGE_KEY}");`,
  'if(t!=="light"&&t!=="dark")return;',
  "var r=document.documentElement;",
  'r.setAttribute("data-theme",t);',
  "var s=function(){",
  "var l=document.querySelectorAll('source[media=\"(prefers-color-scheme: dark)\"]');",
  "for(var i=0;i<l.length;i++){",
  'l[i].setAttribute("data-theme-media","");',
  'l[i].setAttribute("media",t==="dark"?"all":"not all")}};',
  "s();",
  "var o=new MutationObserver(s);",
  "o.observe(r,{childList:true,subtree:true});",
  'document.addEventListener("DOMContentLoaded",function(){s();o.disconnect()})',
  "}catch(e){}})();",
].join("");

/** CSP source that allows `THEME_SCRIPT` inline: the SHA-256 of its exact text. */
export const THEME_SCRIPT_HASH = "'sha256-bB+UzCV5I75Sle4TiwWHlXEFrlz4jA8CFM6Je357FuQ='";
