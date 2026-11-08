// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { axeViolations } from "../testing/axe.ts";
import { ConfirmDialog } from "./confirm-dialog.tsx";

afterEach(cleanup);

function Harness({
  busy = false,
  onConfirm = () => {},
}: {
  busy?: boolean;
  onConfirm?: () => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <main>
      <h1>Artifact</h1>
      <button type="button" onClick={() => setOpen(true)}>
        Delete artifact
      </button>
      <ConfirmDialog
        open={open}
        title="Delete this artifact?"
        confirmLabel="Delete"
        cancelLabel="Keep it"
        busy={busy}
        onConfirm={() => {
          onConfirm();
          setOpen(false);
        }}
        onCancel={() => setOpen(false)}
      >
        This cannot be undone.
      </ConfirmDialog>
    </main>
  );
}

function dialog(): HTMLDialogElement {
  return document.querySelector("dialog") as HTMLDialogElement;
}

describe("ConfirmDialog", () => {
  it("opens as a modal named by its title and described by its body", () => {
    render(<Harness />);
    expect(dialog().open).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Delete artifact" }));
    expect(dialog().open).toBe(true);
    const shown = screen.getByRole("dialog", { name: "Delete this artifact?" });
    const description = document.getElementById(shown.getAttribute("aria-describedby") ?? "");
    expect(description?.textContent).toBe("This cannot be undone.");
  });

  it("runs the action only when confirmed", () => {
    const onConfirm = vi.fn();
    render(<Harness onConfirm={onConfirm} />);
    fireEvent.click(screen.getByRole("button", { name: "Delete artifact" }));
    fireEvent.click(screen.getByRole("button", { name: "Keep it" }));
    expect(onConfirm).not.toHaveBeenCalled();
    expect(dialog().open).toBe(false);

    fireEvent.click(screen.getByRole("button", { name: "Delete artifact" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(dialog().open).toBe(false);
  });

  it("leaves focus alone while closed", () => {
    render(<Harness />);
    const opener = screen.getByRole("button", { name: "Delete artifact" });
    opener.focus();
    render(<Harness />);
    expect(document.activeElement).toBe(opener);
  });

  it("closes on Escape and returns focus to the control that opened it", () => {
    render(<Harness />);
    const opener = screen.getByRole("button", { name: "Delete artifact" });
    opener.focus();
    fireEvent.click(opener);
    fireEvent(dialog(), new Event("cancel", { cancelable: true }));
    expect(dialog().open).toBe(false);
    expect(document.activeElement).toBe(opener);
  });

  it("cannot be dismissed or confirmed again while the action runs", () => {
    const onConfirm = vi.fn();
    render(<Harness busy onConfirm={onConfirm} />);
    fireEvent.click(screen.getByRole("button", { name: "Delete artifact" }));
    fireEvent(dialog(), new Event("cancel", { cancelable: true }));
    expect(dialog().open).toBe(true);
    const confirm = screen.getByRole("button", { name: "Delete" });
    expect(confirm.getAttribute("aria-busy")).toBe("true");
    expect(screen.getByRole("button", { name: "Keep it" })).toHaveProperty("disabled", true);
  });

  it("has no axe violations while open", async () => {
    const { container } = render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "Delete artifact" }));
    expect(await axeViolations(container)).toEqual([]);
  });
});
