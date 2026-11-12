// Decision 0026, delivery 3: every delivery order of small lifecycle, replay and erasure sets against reference models, against the in-memory reference object. The same suite drives
// the real documents object in workerd (apps/data/test).
import { memoryObject } from "../testing/artifact-data-object.ts";
import { modelCheckSuite } from "../testing/artifact-data-suites/model-check.ts";

// Every order, in slices so no single test outgrows the time limit on a loaded CI runner.
modelCheckSuite(memoryObject, { slices: 12 });
