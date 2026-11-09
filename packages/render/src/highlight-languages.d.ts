// highlight.js's language modules ship no types.
declare module "highlight.js/lib/languages/*" {
  const language: import("./hljs-core.js").LanguageFn;
  export default language;
}
