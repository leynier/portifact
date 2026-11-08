// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { axeViolations } from "../testing/axe.ts";
import { Checkbox, RadioGroup, Select, TextInput } from "./fields.tsx";

afterEach(cleanup);

const describedText = (element: HTMLElement) =>
  (element.getAttribute("aria-describedby") ?? "")
    .split(" ")
    .filter(Boolean)
    .map((id) => document.getElementById(id)?.textContent)
    .join(" | ");

describe("TextInput", () => {
  it("is named by its visible label and reads its hint", async () => {
    const { container } = render(
      <TextInput label="Email address" description="They sign in with it" type="email" />,
    );
    const input = screen.getByRole("textbox", { name: "Email address" });
    expect(input.getAttribute("type")).toBe("email");
    expect(input.hasAttribute("aria-invalid")).toBe(false);
    expect(describedText(input)).toBe("They sign in with it");
    expect(await axeViolations(container)).toEqual([]);
  });

  it("marks itself invalid and links the error after the hint", async () => {
    const { container } = render(
      <TextInput label="Email address" description="Hint" error="Enter a valid email address" />,
    );
    const input = screen.getByRole("textbox", { name: "Email address" });
    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect(describedText(input)).toBe("Hint | Enter a valid email address");
    expect(await axeViolations(container)).toEqual([]);
  });

  it("has no description at all without a hint or error", () => {
    render(<TextInput label="Name" />);
    expect(screen.getByRole("textbox", { name: "Name" }).hasAttribute("aria-describedby")).toBe(
      false,
    );
  });
});

describe("Checkbox", () => {
  it("toggles through its label and reads its hint", async () => {
    const onChange = vi.fn();
    const { container } = render(
      <Checkbox
        label="Let search engines index it"
        description="Only while public"
        onChange={onChange}
      />,
    );
    const box = screen.getByRole("checkbox", { name: "Let search engines index it" });
    expect(describedText(box)).toBe("Only while public");
    fireEvent.click(screen.getByText("Let search engines index it"));
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(await axeViolations(container)).toEqual([]);
  });

  it("can be disabled and has no hint by default", () => {
    render(<Checkbox label="Embed" disabled />);
    const box = screen.getByRole("checkbox", { name: "Embed" });
    expect(box).toHaveProperty("disabled", true);
    expect(box.hasAttribute("aria-describedby")).toBe(false);
  });
});

describe("RadioGroup", () => {
  const options = [
    { value: "a", label: "Only you", description: "Nobody else" },
    { value: "b", label: "Everyone" },
    { value: "c", label: "Public", description: "Not yet", disabled: true },
  ] as const;

  it("is a named group of radios with the chosen one checked and hints linked", async () => {
    const onChange = vi.fn();
    const { container } = render(
      <RadioGroup
        legend="Who can open it"
        name="mode"
        value="a"
        options={options}
        onChange={onChange}
      />,
    );
    const group = screen.getByRole("group", { name: "Who can open it" });
    expect(group).toBeTruthy();
    const only = screen.getByRole("radio", { name: "Only you" });
    expect(only).toHaveProperty("checked", true);
    expect(describedText(only)).toBe("Nobody else");
    expect(screen.getByRole("radio", { name: "Everyone" }).hasAttribute("aria-describedby")).toBe(
      false,
    );
    expect(screen.getByRole("radio", { name: "Public" })).toHaveProperty("disabled", true);
    fireEvent.click(screen.getByRole("radio", { name: "Everyone" }));
    expect(onChange).toHaveBeenCalledWith("b");
    expect(await axeViolations(container)).toEqual([]);
  });

  it("disables every option at once", () => {
    render(
      <RadioGroup
        legend="Mode"
        name="m"
        value="a"
        options={options}
        onChange={() => {}}
        disabled
      />,
    );
    expect(screen.getByRole("group", { name: "Mode" })).toHaveProperty("disabled", true);
  });
});

describe("Select", () => {
  const options = [
    { value: "any", label: "Any state" },
    { value: "active", label: "Active" },
    { value: "archived", label: "Archived" },
  ] as const;

  it("is named by its label, shows the chosen option and reports a new choice", async () => {
    const onChange = vi.fn();
    const { container } = render(
      <Select
        label="State"
        description="Drafts are never listed"
        value="active"
        options={options}
        onChange={onChange}
      />,
    );
    const select = screen.getByRole("combobox", { name: "State" }) as HTMLSelectElement;
    expect(select.value).toBe("active");
    expect(screen.getAllByRole("option").map((option) => option.textContent)).toEqual([
      "Any state",
      "Active",
      "Archived",
    ]);
    expect(describedText(select)).toBe("Drafts are never listed");
    fireEvent.change(select, { target: { value: "archived" } });
    expect(onChange).toHaveBeenCalledWith("archived");
    expect(await axeViolations(container)).toEqual([]);
  });

  it("marks itself invalid with the error linked, and can be disabled", async () => {
    const { container } = render(
      <Select
        label="State"
        value="any"
        options={options}
        onChange={() => {}}
        error="Choose a state"
        disabled
      />,
    );
    const select = screen.getByRole("combobox", { name: "State" });
    expect(select.getAttribute("aria-invalid")).toBe("true");
    expect(describedText(select)).toBe("Choose a state");
    expect((select as HTMLSelectElement).disabled).toBe(true);
    expect(await axeViolations(container)).toEqual([]);
  });

  it("ignores a value that is not one of its options", () => {
    const onChange = vi.fn();
    render(<Select label="State" value="any" options={options} onChange={onChange} />);
    const select = screen.getByRole("combobox", { name: "State" }) as HTMLSelectElement;
    const forged = document.createElement("option");
    forged.value = "deleted";
    select.append(forged);
    fireEvent.change(select, { target: { value: "deleted" } });
    expect(onChange).not.toHaveBeenCalled();
  });
});
