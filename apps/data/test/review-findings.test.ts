// Decision 0026: the four design reviews' reproductions, unchanged, through the real documents object on SQLite.
import { reviewFindingsSuite } from "@portifact/domain/testing/artifact-data";
import { realObject } from "./driver.ts";

reviewFindingsSuite(realObject);
