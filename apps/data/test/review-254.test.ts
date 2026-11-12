// Decision 0026: the first code review's reproductions (#254), unchanged, through the real documents object on SQLite.
import { review254Suite } from "@portifact/domain/testing/artifact-data";
import { realObject } from "./driver.ts";

review254Suite(realObject);
