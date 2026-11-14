// The page's reach in `read` and `shared` collections (decision 0026, delivery 9) through the
// real documents object on SQLite.
import { pageModesSuite } from "@portifact/domain/testing/artifact-data";
import { realObject } from "./driver.ts";

pageModesSuite(realObject);
