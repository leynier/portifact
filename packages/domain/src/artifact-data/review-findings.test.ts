// Decision 0026, delivery 3: the four design reviews' reproductions, against the in-memory reference object. The same suite drives
// the real documents object in workerd (apps/data/test).
import { memoryObject } from "../testing/artifact-data-object.ts";
import { reviewFindingsSuite } from "../testing/artifact-data-suites/review-findings.ts";

reviewFindingsSuite(memoryObject);
