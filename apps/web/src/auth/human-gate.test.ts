// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";
import type { HumanCheckCallbacks, HumanCheckWidget } from "../human-check/turnstile.ts";
import { humanGate } from "./human-gate.ts";

function fakeWidget() {
  const instances: { callbacks: HumanCheckCallbacks; removed: boolean }[] = [];
  const widget: HumanCheckWidget = {
    render(_container, callbacks) {
      const instance = { callbacks, removed: false };
      instances.push(instance);
      return () => {
        instance.removed = true;
      };
    },
  };
  return { widget, instances };
}

const view = () => ({ container: document.createElement("div"), setInteractive: vi.fn() });

describe("humanGate stop", () => {
  it("removes the challenge and ends a wait without a token", async () => {
    const { widget, instances } = fakeWidget();
    const gate = humanGate(widget, view());
    gate.prepare();
    const waiting = gate.take();
    gate.stop();
    await expect(waiting).resolves.toBeUndefined();
    expect(instances[0]?.removed).toBe(true);
  });

  it("starts a fresh challenge when used again after stopping", async () => {
    const { widget, instances } = fakeWidget();
    const gate = humanGate(widget, view());
    gate.prepare();
    instances[0]?.callbacks.onError?.();
    gate.stop();
    gate.prepare();
    expect(instances).toHaveLength(2);
    instances[1]?.callbacks.onToken("fresh");
    await expect(gate.take()).resolves.toBe("fresh");
  });

  it("does nothing without a widget", async () => {
    const gate = humanGate(null, view());
    gate.stop();
    await expect(gate.take()).resolves.toBeUndefined();
  });
});
