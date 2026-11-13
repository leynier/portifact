// Decision 0026, delivery 3: the second code review's reproductions (#254), against the in-memory reference object. The same suite drives
// the real documents object in workerd (apps/data/test).
import { memoryObject } from "../testing/artifact-data-object.ts";
import { review254R2Suite } from "../testing/artifact-data-suites/review-254-r2.ts";

review254R2Suite(memoryObject);
