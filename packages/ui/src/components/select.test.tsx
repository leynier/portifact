// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { axeViolations } from "../testing/axe.ts";
import { placeListbox, Select, type SelectProps, typeaheadMatch } from "./select.tsx";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const describedText = (element: HTMLElement) =>
  (element.getAttribute("aria-describedby") ?? "")
    .split(" ")
    .filter(Boolean)
    .map((id) => document.getElementById(id)?.textContent)
    .join(" | ");

const OPTIONS = [
  { value: "any", label: "Any state" },
  { value: "active", label: "Active" },
  { value: "archived", label: "Archived" },
  { value: "suspended", label: "Suspended" },
] as const;
type State = (typeof OPTIONS)[number]["value"];

/** A select that keeps its own value, like a screen does, and records each change. */
function Controlled(
  props: Partial<SelectProps<State>> & { initial?: State; onPick?: (value: State) => void },
) {
  const { initial = "active", onPick, ...rest } = props;
  const [value, setValue] = useState<State>(initial);
  return (
    <Select<State>
      label="State"
      options={OPTIONS}
      {...rest}
      value={value}
      onChange={(next) => {
        setValue(next);
        onPick?.(next);
      }}
    />
  );
}

const combobox = (name = "State") => screen.getByRole("combobox", { name });
const press = (key: string, init: Partial<KeyboardEventInit> = {}) =>
  fireEvent.keyDown(combobox(), { key, ...init });
const activeOption = (name = "State") => {
  const id = combobox(name).getAttribute("aria-activedescendant");
  return id ? document.getElementById(id)?.textContent : undefined;
};

describe("Select", () => {
  it("is named by its label, shows the chosen option and reads its hint", async () => {
    const { container } = render(<Controlled description="Drafts are never listed" />);
    const trigger = combobox();
    expect(trigger.textContent).toBe("Active");
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(trigger.getAttribute("aria-haspopup")).toBe("listbox");
    expect(describedText(trigger)).toBe("Drafts are never listed");
    // Closed, nothing of the list is in the page.
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(await axeViolations(container)).toEqual([]);
  });

  it("opens a named listbox with a check on the chosen option and chooses with a click", async () => {
    const onPick = vi.fn();
    // In a landmark, so axe can check the whole document with the list open at its end.
    render(
      <main>
        <Controlled onPick={onPick} />
      </main>,
    );
    const trigger = combobox();
    trigger.focus();
    fireEvent.click(trigger);
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    const list = screen.getByRole("listbox", { name: "State" });
    expect(trigger.getAttribute("aria-controls")).toBe(list.id);
    const options = within(list).getAllByRole("option");
    expect(options.map((option) => option.textContent)).toEqual([
      "Any state",
      "Active",
      "Archived",
      "Suspended",
    ]);
    expect(options.map((option) => option.getAttribute("aria-selected"))).toEqual([
      "false",
      "true",
      "false",
      "false",
    ]);
    // The chosen option carries a check icon, not only a tone.
    expect(options[1]?.querySelector("svg")).toBeTruthy();
    expect(options[0]?.querySelector("svg")).toBeNull();
    expect(await axeViolations(document.body)).toEqual([]);

    fireEvent.click(within(list).getByRole("option", { name: "Archived" }));
    expect(onPick).toHaveBeenCalledWith("archived");
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(trigger.textContent).toBe("Archived");
    expect(document.activeElement).toBe(trigger);
  });

  it("does not report choosing the option that is already chosen", () => {
    const onPick = vi.fn();
    render(<Controlled onPick={onPick} />);
    fireEvent.click(combobox());
    fireEvent.click(screen.getByRole("option", { name: "Active" }));
    expect(onPick).not.toHaveBeenCalled();
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("works from the keyboard: arrows, Home, End, Enter, Space and Escape", () => {
    const onPick = vi.fn();
    render(<Controlled onPick={onPick} />);
    combobox().focus();

    // Down opens on the chosen option without changing it.
    press("ArrowDown");
    expect(screen.getByRole("listbox")).toBeTruthy();
    expect(activeOption()).toBe("Active");
    press("ArrowDown");
    expect(activeOption()).toBe("Archived");
    press("End");
    expect(activeOption()).toBe("Suspended");
    press("ArrowDown");
    expect(activeOption()).toBe("Suspended");
    press("Home");
    expect(activeOption()).toBe("Any state");
    press("ArrowUp");
    expect(activeOption()).toBe("Any state");
    // Escape closes and keeps the value.
    press("Escape");
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(onPick).not.toHaveBeenCalled();
    expect(combobox().textContent).toBe("Active");

    // Enter opens, moves and chooses.
    press("Enter");
    press("ArrowDown");
    press("Enter");
    expect(onPick).toHaveBeenLastCalledWith("archived");
    expect(screen.queryByRole("listbox")).toBeNull();

    // Space opens and chooses too; End opens straight on the last option.
    press(" ");
    expect(activeOption()).toBe("Archived");
    press("ArrowUp");
    press(" ");
    expect(onPick).toHaveBeenLastCalledWith("active");
    press("End");
    expect(activeOption()).toBe("Suspended");
    press("Home");
    expect(activeOption()).toBe("Any state");
    // Alt+Up chooses the highlighted option and closes, like a native select.
    press("ArrowUp", { altKey: true });
    expect(onPick).toHaveBeenLastCalledWith("any");
    expect(document.activeElement).toBe(combobox());
  });

  it("opens on Home from a closed list and moves by pages", () => {
    const many = Array.from({ length: 25 }, (_, i) => ({
      value: `v${i}`,
      label: `Option ${String(i).padStart(2, "0")}`,
    }));
    render(<Select label="Many" value="v0" options={many} onChange={() => {}} />);
    combobox("Many").focus();
    fireEvent.keyDown(combobox("Many"), { key: "Home" });
    expect(activeOption("Many")).toBe("Option 00");
    fireEvent.keyDown(combobox("Many"), { key: "PageDown" });
    expect(activeOption("Many")).toBe("Option 10");
    fireEvent.keyDown(combobox("Many"), { key: "PageDown" });
    fireEvent.keyDown(combobox("Many"), { key: "PageDown" });
    expect(activeOption("Many")).toBe("Option 24");
    fireEvent.keyDown(combobox("Many"), { key: "PageUp" });
    expect(activeOption("Many")).toBe("Option 14");
  });

  it("chooses the highlighted option when Tab leaves the list", () => {
    const onPick = vi.fn();
    render(<Controlled onPick={onPick} />);
    combobox().focus();
    press("ArrowDown");
    press("ArrowDown");
    press("Tab");
    expect(onPick).toHaveBeenCalledWith("archived");
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("jumps to an option by typing the start of its label, closed or open", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const onPick = vi.fn();
    render(<Controlled onPick={onPick} />);
    combobox().focus();
    // Closed: typing opens on the first match after the chosen option.
    press("s");
    expect(activeOption()).toBe("Suspended");
    vi.advanceTimersByTime(600);
    // Open: a longer prefix narrows, and the same letter again cycles.
    press("a");
    expect(activeOption()).toBe("Any state");
    press("r");
    expect(activeOption()).toBe("Archived");
    vi.advanceTimersByTime(600);
    press("a");
    expect(activeOption()).toBe("Any state");
    press("a");
    expect(activeOption()).toBe("Active");
    // A letter no option starts with keeps the highlight.
    vi.advanceTimersByTime(600);
    press("z");
    expect(activeOption()).toBe("Active");
    press("ArrowDown");
    press("Enter");
    expect(onPick).toHaveBeenCalledWith("archived");
  });

  it("closes on a press outside or when focus leaves, keeping the value", () => {
    const onPick = vi.fn();
    const onBlur = vi.fn();
    render(
      <>
        <Controlled onPick={onPick} onBlur={onBlur} />
        <button type="button">Elsewhere</button>
      </>,
    );
    fireEvent.click(combobox());
    expect(screen.getByRole("listbox")).toBeTruthy();
    fireEvent.pointerDown(screen.getByRole("button", { name: "Elsewhere" }));
    expect(screen.queryByRole("listbox")).toBeNull();

    fireEvent.click(combobox());
    // A press inside the list does not close it.
    fireEvent.pointerDown(screen.getByRole("option", { name: "Archived" }));
    expect(screen.getByRole("listbox")).toBeTruthy();
    fireEvent.blur(combobox());
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(onBlur).toHaveBeenCalled();
    expect(onPick).not.toHaveBeenCalled();
  });

  it("highlights the option under the pointer, so Enter chooses it", () => {
    const onPick = vi.fn();
    render(<Controlled onPick={onPick} />);
    combobox().focus();
    fireEvent.click(combobox());
    fireEvent.pointerMove(screen.getByRole("option", { name: "Suspended" }));
    expect(activeOption()).toBe("Suspended");
    press("Enter");
    expect(onPick).toHaveBeenCalledWith("suspended");
  });

  it("marks itself invalid with the error linked, and can be disabled", async () => {
    const { container } = render(
      <Select
        label="State"
        value="any"
        options={OPTIONS}
        onChange={() => {}}
        error="Choose a state"
        disabled
      />,
    );
    const trigger = combobox();
    expect(trigger.getAttribute("aria-invalid")).toBe("true");
    expect(describedText(trigger)).toBe("Choose a state");
    expect(trigger).toHaveProperty("disabled", true);
    fireEvent.click(trigger);
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(await axeViolations(container)).toEqual([]);
  });

  it("keeps a hidden label as the accessible name, and its visible label focuses it", async () => {
    const { container } = render(
      <>
        <Select
          label="State of ana"
          labelVisible={false}
          value="any"
          options={OPTIONS}
          onChange={() => {}}
        />
        <Select label="Kind" value="any" options={OPTIONS} onChange={() => {}} />
      </>,
    );
    expect(combobox("State of ana").textContent).toBe("Any state");
    expect(screen.getByText("State of ana").className).toBe("sr-only");
    expect(screen.getByText("Kind").getAttribute("for")).toBe(combobox("Kind").id);
    expect(await axeViolations(container)).toEqual([]);
  });

  it("shows a compact chip with its label and value inside, for toolbars", async () => {
    const onPick = vi.fn();
    const { container } = render(
      <Controlled variant="compact" active initial="archived" name="state" onPick={onPick} />,
    );
    const trigger = combobox();
    // The visible label starts the trigger, so the accessible name matches what is shown.
    expect(trigger.textContent).toBe("StateArchived");
    expect(within(trigger).getByText("Archived").className).toContain("font-semibold");
    expect((container.querySelector("input[name=state]") as HTMLInputElement).value).toBe(
      "archived",
    );
    expect(await axeViolations(container)).toEqual([]);
    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole("option", { name: "Any state" }));
    expect(onPick).toHaveBeenCalledWith("any");
  });
});

describe("placeListbox", () => {
  const view = { width: 1000, height: 800 };

  it("opens under the trigger, at least as wide as it", () => {
    expect(
      placeListbox(
        { top: 100, bottom: 140, left: 50, width: 200 },
        { width: 150, height: 160 },
        view,
      ),
    ).toEqual({ top: 144, left: 50, maxHeight: 648, width: 200 });
  });

  it("opens above when there is more room there and the list does not fit below", () => {
    const spot = placeListbox(
      { top: 700, bottom: 740, left: 50, width: 200 },
      { width: 200, height: 300 },
      view,
    );
    expect(spot.top).toBe(700 - 4 - 300);
    expect(spot.maxHeight).toBe(688);
  });

  it("stays inside the window on both sides and scrolls when it is too tall", () => {
    const right = placeListbox(
      { top: 100, bottom: 140, left: 900, width: 80 },
      { width: 300, height: 100 },
      view,
    );
    expect(right.left).toBe(1000 - 8 - 300);
    const tall = placeListbox(
      { top: 400, bottom: 440, left: -20, width: 80 },
      { width: 2000, height: 5000 },
      view,
    );
    expect(tall.left).toBe(8);
    expect(tall.width).toBe(984);
    expect(tall.maxHeight).toBe(400 - 4 - 8);
    expect(tall.top).toBe(8);
  });
});

describe("typeaheadMatch", () => {
  const labels = ["Any", "Active", "Archived", "Budget"];

  it("finds the next label with the typed start, wrapping, and cycles on a repeated letter", () => {
    expect(typeaheadMatch(labels, "a", 0)).toBe(1);
    expect(typeaheadMatch(labels, "a", 2)).toBe(0);
    expect(typeaheadMatch(labels, "ar", 0)).toBe(2);
    expect(typeaheadMatch(labels, "aa", 1)).toBe(2);
    expect(typeaheadMatch(labels, "B", 3)).toBe(3);
    expect(typeaheadMatch(labels, "x", 0)).toBeNull();
  });
});
