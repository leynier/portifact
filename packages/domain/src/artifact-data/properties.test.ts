// Decision 0026, delivery 3: random command sequences checked against the record's invariants, against the in-memory reference object. The same suite drives
// the real documents object in workerd (apps/data/test).
import { memoryObject } from "../testing/artifact-data-object.ts";
import { propertiesSuite } from "../testing/artifact-data-suites/properties.ts";

// Sliced so no single test outgrows the time limit on a loaded CI runner (the same number of
// sequences), and seeded: with a random seed the check that every command path is reached can
// fail on a draw that never reaches one (seen once, `bulk:ok`, in another change's full run).
propertiesSuite(memoryObject, { slices: 10, seed: 2026 });
