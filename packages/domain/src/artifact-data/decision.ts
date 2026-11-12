// The answer of every decision of the artifact data protocols (decision 0026): a value, or a
// refusal with one of the object's codes. Delivery 5 maps the codes to the API's.
import type { DataRefusalCode } from "@portifact/contracts/artifact-data";

export interface Refusal {
  ok: false;
  code: DataRefusalCode;
  message: string;
}

export type Decision<T> = { ok: true; value: T } | Refusal;

export const accept = <T>(value: T): Decision<T> => ({ ok: true, value });

export const refuse = (code: DataRefusalCode, message: string): Refusal => ({
  ok: false,
  code,
  message,
});
