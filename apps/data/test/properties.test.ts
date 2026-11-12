// Decision 0026: random command sequences checked against the record's invariants after every
// step, through the real documents object on SQLite: alone (its own meters and oracle), and paired
// with the in-memory reference, where every answer and state must agree step by step. A bounded
// run with fixed seeds: each command is a request into the object, and the reference runs the long
// sequences (200 and 60 runs) on every change.
import { propertiesSuite } from "@portifact/domain/testing/artifact-data";
import { describe } from "vitest";
import { realObject } from "./driver.ts";
import { pairObjects } from "./pair.ts";

describe("the real object alone", () => {
  propertiesSuite(realObject, { runs: 20, longRuns: 5, seed: 2026 });
});

describe("the real object paired with the reference", () => {
  propertiesSuite(pairObjects, { runs: 20, longRuns: 5, seed: 2026 });
});
