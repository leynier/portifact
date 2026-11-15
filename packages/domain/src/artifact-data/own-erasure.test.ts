// Decision 0026, a person's rights: their own erasure against the in-memory reference object. The
// same suite drives the real documents object in workerd (apps/data/test).
import { memoryObject } from "../testing/artifact-data-object.ts";
import { ownErasureSuite } from "../testing/artifact-data-suites/own-erasure.ts";

ownErasureSuite(memoryObject);
