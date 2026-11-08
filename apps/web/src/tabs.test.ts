// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from "vitest";
import { setupTabs } from "./tabs.ts";

const markup = `
  <div role="tablist" aria-label="Interfaces">
    <button type="button" role="tab" id="tab-a" aria-controls="panel-a" aria-selected="false">A</button>
    <button type="button" role="tab" id="tab-b" aria-controls="panel-b" aria-selected="true">B</button>
    <button type="button" role="tab" id="tab-c" aria-controls="panel-c" aria-selected="false">C</button>
  </div>
  <div role="tabpanel" id="panel-a" aria-labelledby="tab-a">Panel A</div>
  <div role="tabpanel" id="panel-b" aria-labelledby="tab-b">Panel B</div>
  <div role="tabpanel" id="panel-c" aria-labelledby="tab-c">Panel C</div>
`;

function tab(id: string): HTMLElement {
  const element = document.getElementById(`tab-${id}`);
  if (!element) throw new Error(`tab ${id} not rendered`);
  return element;
}

function panel(id: string): HTMLElement {
  const element = document.getElementById(`panel-${id}`);
  if (!element) throw new Error(`panel ${id} not rendered`);
  return element;
}

function press(id: string, key: string): KeyboardEvent {
  const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
  tab(id).dispatchEvent(event);
  return event;
}

function expectSelected(id: string): void {
  for (const other of ["a", "b", "c"]) {
    const selected = other === id;
    expect(tab(other).getAttribute("aria-selected")).toBe(String(selected));
    expect(tab(other).tabIndex).toBe(selected ? 0 : -1);
    expect(panel(other).hidden).toBe(!selected);
  }
}

describe("tabs", () => {
  beforeEach(() => {
    document.body.innerHTML = markup;
  });

  it("starts on the tab marked as selected and hides the other panels", () => {
    expect(setupTabs(document)).toBe(1);
    expectSelected("b");
  });

  it("selects a tab on click", () => {
    setupTabs(document);
    tab("c").click();
    expectSelected("c");
  });

  it("moves with the arrow keys, wraps around and moves focus", () => {
    setupTabs(document);

    const event = press("b", "ArrowRight");
    expect(event.defaultPrevented).toBe(true);
    expectSelected("c");
    expect(document.activeElement).toBe(tab("c"));

    press("c", "ArrowRight");
    expectSelected("a");

    press("a", "ArrowLeft");
    expectSelected("c");
  });

  it("jumps to the first and last tab with Home and End", () => {
    setupTabs(document);
    press("b", "End");
    expectSelected("c");
    press("c", "Home");
    expectSelected("a");
  });

  it("leaves other keys to the browser", () => {
    setupTabs(document);
    const event = press("b", "Tab");
    expect(event.defaultPrevented).toBe(false);
    expectSelected("b");
  });

  it("selects the first tab when none is marked and tolerates a missing panel", () => {
    document.body.innerHTML = `
      <div role="tablist">
        <button type="button" role="tab" id="tab-x" aria-controls="missing">X</button>
        <button type="button" role="tab" id="tab-y">Y</button>
      </div>`;
    setupTabs(document);
    expect(tab("x").getAttribute("aria-selected")).toBe("true");
    tab("y").click();
    expect(tab("y").getAttribute("aria-selected")).toBe("true");
    expect(tab("x").tabIndex).toBe(-1);
  });

  it("does nothing for a tablist without tabs", () => {
    document.body.innerHTML = `<div role="tablist"></div>`;
    expect(setupTabs(document)).toBe(1);
  });
});
