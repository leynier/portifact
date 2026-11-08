// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { axeViolations } from "../testing/axe.ts";
import { TextArea } from "./fields.tsx";
import { canPickFolders, FilePicker } from "./file-picker.tsx";
import { PreviewFrame } from "./preview-frame.tsx";
import { ProgressBar } from "./progress.tsx";

afterEach(cleanup);

describe("ProgressBar", () => {
  it("is a progress bar named by its label that reads its progress in words", async () => {
    const { container } = render(
      <ProgressBar label="Uploading" value={30} max={120} valueText="30 B of 120 B" />,
    );
    const bar = screen.getByRole("progressbar", { name: "Uploading" });
    expect(bar.getAttribute("value")).toBe("30");
    expect(bar.getAttribute("max")).toBe("120");
    expect(bar.getAttribute("aria-valuetext")).toBe("30 B of 120 B");
    const described = document.getElementById(bar.getAttribute("aria-describedby") ?? "");
    expect(described?.textContent).toBe("30 B of 120 B");
    expect(await axeViolations(container)).toEqual([]);
  });

  it("clamps its value and is indeterminate without one", () => {
    const { rerender } = render(
      <ProgressBar label="Hashing" value={500} max={100} valueText="x" />,
    );
    expect(screen.getByRole("progressbar").getAttribute("value")).toBe("100");
    rerender(<ProgressBar label="Hashing" value={-5} max={100} valueText="x" />);
    expect(screen.getByRole("progressbar").getAttribute("value")).toBe("0");
    rerender(<ProgressBar label="Hashing" max={100} valueText="Starting" />);
    expect(screen.getByRole("progressbar").hasAttribute("value")).toBe(false);
  });
});

describe("FilePicker", () => {
  const pick = (input: HTMLElement, files: File[]) => {
    Object.defineProperty(input, "files", { value: files, configurable: true });
    fireEvent.change(input);
  };

  it("is a labelled file input that reports the chosen files", async () => {
    const onPick = vi.fn();
    const { container } = render(
      <FilePicker
        label="Choose a ZIP file"
        description="Up to 250 MB"
        accept=".zip"
        onPick={onPick}
      />,
    );
    const input = screen.getByLabelText("Choose a ZIP file");
    expect(input.getAttribute("type")).toBe("file");
    expect(input.getAttribute("accept")).toBe(".zip");
    expect(input.hasAttribute("multiple")).toBe(false);
    expect(document.getElementById(input.getAttribute("aria-describedby") ?? "")?.textContent).toBe(
      "Up to 250 MB",
    );
    const file = new File(["x"], "site.zip");
    pick(input, [file]);
    expect(onPick).toHaveBeenCalledWith([file]);
    expect(await axeViolations(container)).toEqual([]);
  });

  it("does not report an empty choice", () => {
    const onPick = vi.fn();
    render(<FilePicker label="Choose files" multiple onPick={onPick} />);
    pick(screen.getByLabelText("Choose files"), []);
    expect(onPick).not.toHaveBeenCalled();
  });

  it("asks for a whole folder when told to, and can be disabled", () => {
    render(<FilePicker label="Choose a folder" folder disabled onPick={() => {}} />);
    const input = screen.getByLabelText("Choose a folder");
    expect(input.hasAttribute("webkitdirectory")).toBe(true);
    expect(input.hasAttribute("multiple")).toBe(true);
    expect(input).toHaveProperty("disabled", true);
  });

  it("tells whether the browser can pick folders", () => {
    const prototype = HTMLInputElement.prototype as unknown as Record<string, unknown>;
    const had = "webkitdirectory" in prototype;
    if (!had) prototype.webkitdirectory = false;
    expect(canPickFolders()).toBe(true);
    if (!had) delete prototype.webkitdirectory;
    expect(canPickFolders()).toBe(had);
  });
});

describe("PreviewFrame", () => {
  it("shows untrusted markup in a fully sandboxed, titled frame without fetching it", async () => {
    const { container } = render(
      <PreviewFrame title="Preview of Plan" html="<!doctype html><p>Hi</p>" />,
    );
    const frame = container.querySelector("iframe");
    expect(frame?.getAttribute("title")).toBe("Preview of Plan");
    expect(frame?.getAttribute("sandbox")).toBe("");
    expect(frame?.getAttribute("srcdoc")).toBe("<!doctype html><p>Hi</p>");
    expect(frame?.hasAttribute("src")).toBe(false);
    expect(await axeViolations(container)).toEqual([]);
  });
});

describe("TextArea", () => {
  it("is a labelled multi-line field with its hint and error linked", async () => {
    const { container } = render(
      <TextArea label="Document" description="Markdown" error="Write something" code />,
    );
    const area = screen.getByRole("textbox", { name: "Document" });
    expect(area.tagName).toBe("TEXTAREA");
    expect(area.getAttribute("aria-invalid")).toBe("true");
    expect(area.getAttribute("spellcheck")).toBe("false");
    const ids = (area.getAttribute("aria-describedby") ?? "").split(" ");
    expect(ids.map((id) => document.getElementById(id)?.textContent)).toEqual([
      "Markdown",
      "Write something",
    ]);
    expect(await axeViolations(container)).toEqual([]);
  });

  it("checks spelling of prose and has no description without hint or error", () => {
    render(<TextArea label="Notes" />);
    const area = screen.getByRole("textbox", { name: "Notes" });
    expect(area.getAttribute("spellcheck")).toBe("true");
    expect(area.hasAttribute("aria-describedby")).toBe(false);
    expect(area.hasAttribute("aria-invalid")).toBe(false);
  });
});
