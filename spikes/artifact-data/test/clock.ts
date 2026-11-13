// The spike's object reads the real clock on some paths (a fence, an erasure chunk's charge, the
// pending reads' flush), while the tests pass a fixed `NOW` to commands. With the real clock the
// two agree only on the day `NOW` names: the suite passed on 2026-11-12 and failed from the next
// UTC midnight. Every test therefore starts with the date pinned a few hours after `NOW`, still
// advancing with real time; a test that sets its own date keeps doing so.
import { afterEach, beforeEach, vi } from "vitest";
import { NOW } from "./harness.ts";

const STARTS_AT = NOW + 6 * 3_600_000;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"], shouldAdvanceTime: true, now: STARTS_AT });
});

afterEach(() => {
  vi.useRealTimers();
});
