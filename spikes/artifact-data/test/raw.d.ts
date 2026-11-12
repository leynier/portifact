// Vite answers `?raw` imports with the file's text (billing.test.ts reads the object's source).
declare module "*?raw" {
  const text: string;
  export default text;
}
