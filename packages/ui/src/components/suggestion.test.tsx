// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { axeViolations } from "../testing/axe.ts";
import {
  CodePointList,
  codePointName,
  EditDiff,
  ModeSwitch,
  PlanLines,
  SuggestionPreview,
  TypedText,
} from "./suggestion.tsx";
import { Tabs } from "./tabs.tsx";

afterEach(cleanup);

const labels = { removed: "Removed", added: "Added", character: "character", empty: "(nothing)" };

describe("TypedText", () => {
  it("draws characters as chips that literal text cannot imitate, in a direction isolate", () => {
    const { container } = render(
      <TypedText
        tokens={[
          { kind: "text", value: "pay " },
          { kind: "char", codePoint: 0x202e },
          { kind: "text", value: "U+202E" },
        ]}
        characterLabel="character"
        empty="(nothing)"
      />,
    );
    const isolate = container.querySelector("bdi");
    expect(isolate?.textContent).toBe("pay character U+202EU+202E");
    // The real character is a chip with an accessible prefix; the literal spelling is plain text.
    const chips = isolate?.querySelectorAll(".rounded-xs") ?? [];
    expect(chips).toHaveLength(1);
    expect(isolate?.textContent).not.toContain("‮");
  });

  it("says when a field is empty", () => {
    render(<TypedText tokens={[]} characterLabel="character" empty="(nothing)" />);
    expect(screen.getByText("(nothing)")).toBeTruthy();
  });

  it("names code points with at least four digits", () => {
    expect(codePointName(0x41)).toBe("U+0041");
    expect(codePointName(0xe0041)).toBe("U+E0041");
  });
});

describe("EditDiff", () => {
  it("labels the removed and added text in words, not only by color", async () => {
    const { container } = render(
      <EditDiff
        before={[{ kind: "text", value: "cat" }]}
        after={[{ kind: "text", value: "dog" }]}
        labels={labels}
      />,
    );
    const terms = within(container)
      .getAllByRole("term")
      .map((term) => term.textContent);
    expect(terms).toEqual(["- Removed", "+ Added"]);
    expect(
      within(container)
        .getAllByRole("definition")
        .map((d) => d.textContent),
    ).toEqual(["cat", "dog"]);
    expect(await axeViolations(container)).toEqual([]);
  });
});

describe("PlanLines and CodePointList", () => {
  it("lists the server's lines as text, one item each, under a name", async () => {
    const { container } = render(
      <>
        <PlanLines label="What accepting does" lines={["applied: cat → dog", "<b>x</b>"]} />
        <CodePointList label="Code points" codePoints={[0x63, 0x200b]} />
      </>,
    );
    const list = screen.getByRole("list", { name: "What accepting does" });
    expect(
      within(list)
        .getAllByRole("listitem")
        .map((item) => item.textContent),
    ).toEqual(["applied: cat → dog", "<b>x</b>"]);
    expect(container.querySelector("b")).toBeNull();
    expect(screen.getByRole("list", { name: "Code points" }).textContent).toBe("U+0063U+200B");
    expect(await axeViolations(container)).toEqual([]);
  });
});

describe("SuggestionPreview", () => {
  it("frames the preview with an empty sandbox and no referrer", () => {
    render(<SuggestionPreview title="Preview" url="https://preview.portifact.dev/p/abc" />);
    const frame = screen.getByTitle("Preview") as HTMLIFrameElement;
    expect(frame.getAttribute("sandbox")).toBe("");
    expect(frame.getAttribute("referrerpolicy")).toBe("no-referrer");
    expect(frame.getAttribute("src")).toBe("https://preview.portifact.dev/p/abc");
  });
});

describe("ModeSwitch", () => {
  it("shows a mode that is not choosable yet in its place, disabled", () => {
    const onChange = vi.fn();
    render(
      <ModeSwitch
        label="Review mode"
        options={[
          { value: "comment", label: "Comment" },
          { value: "suggest", label: "Suggest", disabled: true },
        ]}
        value="comment"
        onChange={onChange}
      />,
    );
    const suggest = screen.getByRole("button", { name: "Suggest" });
    expect(suggest).toHaveProperty("disabled", true);
    fireEvent.click(suggest);
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Comment" })).toHaveProperty("disabled", false);
  });

  it("is a labelled group of toggle buttons", async () => {
    const onChange = vi.fn();
    const { container } = render(
      <ModeSwitch
        label="Review mode"
        options={[
          { value: "comment", label: "Comment" },
          { value: "suggest", label: "Suggest", name: "Suggest mode" },
        ]}
        value="comment"
        onChange={onChange}
      />,
    );
    const group = screen.getByRole("group", { name: "Review mode" });
    // The accessible name may add to the visible label, never replace it.
    const suggest = within(group).getByRole("button", { name: "Suggest mode" });
    expect(suggest.textContent).toBe("Suggest");
    expect(suggest.getAttribute("aria-pressed")).toBe("false");
    expect(
      within(group).getByRole("button", { name: "Comment" }).getAttribute("aria-pressed"),
    ).toBe("true");
    fireEvent.click(suggest);
    expect(onChange).toHaveBeenCalledWith("suggest");
    expect(await axeViolations(container)).toEqual([]);
  });
});

describe("Tabs", () => {
  const tabs = [
    { id: "change", label: "Change", panel: <p>The diff</p> },
    { id: "preview", label: "Preview", panel: <p>The preview</p> },
  ];

  it("shows one panel and moves between tabs with the arrow keys, Home and End", async () => {
    const onChange = vi.fn();
    const { container } = render(<Tabs label="Suggested change" tabs={tabs} onChange={onChange} />);
    const list = screen.getByRole("tablist", { name: "Suggested change" });
    const [first, second] = within(list).getAllByRole("tab");
    expect(first?.getAttribute("aria-selected")).toBe("true");
    expect(second?.getAttribute("tabindex")).toBe("-1");
    expect(screen.getByRole("tabpanel").textContent).toBe("The diff");
    fireEvent.keyDown(list, { key: "ArrowRight" });
    expect(screen.getByRole("tabpanel").textContent).toBe("The preview");
    expect(document.activeElement).toBe(second);
    fireEvent.keyDown(list, { key: "ArrowRight" });
    expect(screen.getByRole("tabpanel").textContent).toBe("The diff");
    fireEvent.keyDown(list, { key: "End" });
    fireEvent.keyDown(list, { key: "ArrowLeft" });
    fireEvent.keyDown(list, { key: "Home" });
    fireEvent.keyDown(list, { key: "ArrowLeft" });
    expect(screen.getByRole("tabpanel").textContent).toBe("The preview");
    fireEvent.keyDown(list, { key: "a" });
    fireEvent.click(first as HTMLElement);
    expect(onChange).toHaveBeenLastCalledWith("change");
    expect(await axeViolations(container)).toEqual([]);
  });

  it("starts on the tab it is given", () => {
    render(<Tabs label="Suggested change" tabs={tabs} initial="preview" />);
    expect(screen.getByRole("tabpanel").textContent).toBe("The preview");
  });
});
