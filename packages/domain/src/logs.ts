// What a log line may say about a failure. Workers observability is global, outside every region
// (decision 0005, "What leaves the region"), and an error's message is free text that can hold
// an artifact's name, an address, a URL path or an object key. A log line carries only the
// error's name and, when its message starts with an upper-case code (`D1_ERROR: ...`,
// `E_RECIPIENT_SUPPRESSED`), that code. `scripts/log-fields.test.ts` refuses any other value for
// a log line's `error` field.

const CODE = /^([A-Z][A-Z0-9_]{2,39})(?::|$)/;

/** An error as a log line may name it: `TypeError`, `Error:D1_ERROR`, or `string` for a non-error. */
export function errorLabel(error: unknown): string {
  if (!(error instanceof Error)) return typeof error;
  const code = CODE.exec(error.message)?.[1];
  return code ? `${error.name}:${code}` : error.name;
}
