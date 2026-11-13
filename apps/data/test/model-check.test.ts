// Decision 0026: every delivery order of small lifecycle, replay and erasure sets against reference
// models, through the real documents object on SQLite. Each command is a request into the object,
// so this runs every 11th order of each set (a fixed stride), in twelve tests per set: the reference
// checks all of them.
import { modelCheckSuite } from "@portifact/domain/testing/artifact-data";
import { realObject } from "./driver.ts";

modelCheckSuite(realObject, { every: 11, slices: 12 });
