// Decision 0026, delivery 3: the first code review's reproductions (#254), against the in-memory reference object. The same suite drives
// the real documents object in workerd (apps/data/test).
import { memoryObject } from "../testing/artifact-data-object.ts";
import { review254Suite } from "../testing/artifact-data-suites/review-254.ts";

review254Suite(memoryObject);
