// markdown-it-footnote ships no types; the plugin takes the parser and mutates it.
declare module "markdown-it-footnote" {
  import type { MarkdownIt } from "markdown-it";

  const footnotes: (md: MarkdownIt) => void;
  export default footnotes;
}
