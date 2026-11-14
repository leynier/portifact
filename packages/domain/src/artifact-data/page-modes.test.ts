// The page's reach in `read` and `shared` collections (decision 0026, delivery 9) against the
// in-memory reference. The same suite drives the real documents object in workerd (apps/data/test).
import { memoryObject } from "../testing/artifact-data-object.ts";
import { pageModesSuite } from "../testing/artifact-data-suites/page-modes.ts";

pageModesSuite(memoryObject);
