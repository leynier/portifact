// Decision 0026, a person's rights: their own erasure through the real documents object on SQLite.
import { ownErasureSuite } from "@portifact/domain/testing/artifact-data";
import { realObject } from "./driver.ts";

ownErasureSuite(realObject);
