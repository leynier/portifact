// The part of highlight.js's core the renderer uses (see hljs-core.js).

/** A language definition; opaque to the renderer. */
export type LanguageFn = (hljs: unknown) => unknown;

export interface Highlighter {
  registerLanguage(name: string, language: LanguageFn): void;
  getLanguage(name: string): object | undefined;
  highlight(
    code: string,
    options: { language: string; ignoreIllegals?: boolean },
  ): { value: string };
}

declare const hljs: Highlighter & { newInstance(): Highlighter };
export default hljs;
