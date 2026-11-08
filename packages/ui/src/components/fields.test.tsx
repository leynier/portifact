// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { axeViolations } from "../testing/axe.ts";
import { Checkbox, RadioGroup, TextInput } from "./fields.tsx";

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
