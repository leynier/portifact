// Decision 0026, delivery 3: random command sequences checked against the record's invariants, against the in-memory reference object. The same suite drives
// the real documents object in workerd (apps/data/test).
import { memoryObject } from "../testing/artifact-data-object.ts";
import { propertiesSuite } from "../testing/artifact-data-suites/properties.ts";

propertiesSuite(memoryObject);
