// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { axeViolations } from "../testing/axe.ts";
import { Avatar, initials } from "./avatar.tsx";
import { Drawer } from "./drawer.tsx";
import { ResizeHandle } from "./resize-handle.tsx";
import { Tooltip } from "./tooltip.tsx";

afterEach(cleanup);

describe("Avatar", () => {
  it("takes initials from the first and last names, else from the address", () => {
    expect(initials("Ada Lovelace")).toBe("AL");
    expect(initials("  ada  byron lovelace ")).toBe("AL");
    expect(initials("Ada")).toBe("A");
    expect(initials("", "zoe@example.com")).toBe("Z");
    expect(initials("", "")).toBe("?");
    expect(initials("Élodie Ñúñez")).toBe("ÉÑ");
  });

  it("is decorative and shows the initials without a picture", async () => {
    const { container } = render(
      <Avatar name="Ada Lovelace" email="ada@example.com" size="lg" tone="solid" letters={2} />,
    );
    const avatar = container.firstElementChild as HTMLElement;
    expect(avatar.getAttribute("aria-hidden")).toBe("true");
    expect(avatar.textContent).toBe("AL");
    expect(await axeViolations(container)).toEqual([]);
  });

  it("shows the picture, and the initials again when it fails to load", () => {
    const { container } = render(<Avatar name="Ada" image="/ada.png" />);
    const img = container.querySelector("img") as HTMLImageElement;
    expect(img.getAttribute("src")).toBe("/ada.png");
    expect(img.getAttribute("alt")).toBe("");
    fireEvent.error(img);
    expect(container.querySelector("img")).toBeNull();
    expect(container.textContent).toBe("A");
  });
});

describe("Tooltip", () => {
  it("shows its label while the control is hovered or focused, hidden from assistive technology", async () => {
    const { container } = render(
      <Tooltip label="Sign out">
        <button type="button" aria-label="Sign out">
          x
        </button>
      </Tooltip>,
    );
    const button = screen.getByRole("button", { name: "Sign out" });
    expect(container.querySelector("[data-tooltip]")).toBeNull();
    fireEvent.focus(button);
    const bubble = container.querySelector("[data-tooltip]");
    expect(bubble?.textContent).toBe("Sign out");
    expect(bubble?.getAttribute("aria-hidden")).toBe("true");
    expect(await axeViolations(container)).toEqual([]);
    fireEvent.blur(button);
    expect(container.querySelector("[data-tooltip]")).toBeNull();
    fireEvent.pointerEnter(button.parentElement as HTMLElement);
    expect(container.querySelector("[data-tooltip]")).not.toBeNull();
    fireEvent.pointerLeave(button.parentElement as HTMLElement);
    expect(container.querySelector("[data-tooltip]")).toBeNull();
  });

  it("hides on Escape without moving focus", () => {
    const { container } = render(
      <Tooltip label="Collapse sidebar" side="top" block>
        <button type="button">Collapse sidebar</button>
      </Tooltip>,
    );
    const button = screen.getByRole("button");
    button.focus();
    fireEvent.focus(button);
    expect(container.querySelector("[data-tooltip]")).not.toBeNull();
    fireEvent.keyDown(document, { key: "Enter" });
    expect(container.querySelector("[data-tooltip]")).not.toBeNull();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(container.querySelector("[data-tooltip]")).toBeNull();
    expect(document.activeElement).toBe(button);
  });

  it("shows one tooltip at a time", () => {
    const { container } = render(
      <>
        <Tooltip label="Collapse sidebar">
          <button type="button">Collapse sidebar</button>
        </Tooltip>
        <Tooltip label="Usage">
          <a href="/usage">Usage</a>
        </Tooltip>
      </>,
    );
    fireEvent.focus(screen.getByRole("button"));
    fireEvent.pointerEnter(screen.getByRole("link").parentElement as HTMLElement);
    const shown = [...container.querySelectorAll("[data-tooltip]")].map((t) => t.textContent);
    expect(shown).toEqual(["Usage"]);
  });

  it("renders only the control while disabled", () => {
    const { container } = render(
      <Tooltip label="Artifacts" disabled>
        <a href="/">Artifacts</a>
      </Tooltip>,
    );
    expect(container.innerHTML).toBe('<a href="/">Artifacts</a>');
  });
});

function DrawerHarness() {
  const [open, setOpen] = useState(false);
  return (
    <main>
      <button type="button" onClick={() => setOpen(true)}>
        Open navigation
      </button>
      <Drawer
        open={open}
        label="Navigation"
        closeLabel="Close navigation"
        onClose={() => setOpen(false)}
        header={<span>portifact</span>}
      >
        <nav aria-label="Main">
          <a href="#usage">Usage</a>
          <button type="button">Not a link</button>
        </nav>
      </Drawer>
    </main>
  );
}

function drawer(): HTMLDialogElement {
  return document.querySelector("dialog") as HTMLDialogElement;
}

describe("Drawer", () => {
  it("opens as a named modal and renders its content only while open", async () => {
    const { container } = render(<DrawerHarness />);
    expect(drawer().open).toBe(false);
    expect(screen.queryByRole("link", { name: "Usage" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Open navigation" }));
    expect(drawer().open).toBe(true);
    expect(screen.getByRole("dialog", { name: "Navigation" })).toBe(drawer());
    expect(drawer().hasAttribute("data-scroll-lock")).toBe(true);
    expect(screen.getByRole("link", { name: "Usage" })).toBeTruthy();
    expect(await axeViolations(container)).toEqual([]);
  });

  it("closes with its button, Escape, the backdrop and a followed link, returning focus", () => {
    render(<DrawerHarness />);
    const opener = screen.getByRole("button", { name: "Open navigation" });
    const open = () => {
      opener.focus();
      fireEvent.click(opener);
      expect(drawer().open).toBe(true);
    };

    open();
    fireEvent.click(screen.getByRole("button", { name: "Close navigation" }));
    expect(drawer().open).toBe(false);
    expect(document.activeElement).toBe(opener);

    open();
    fireEvent(drawer(), new Event("cancel", { cancelable: true }));
    expect(drawer().open).toBe(false);

    open();
    fireEvent.click(drawer());
    expect(drawer().open).toBe(false);

    open();
    fireEvent.click(screen.getByRole("button", { name: "Not a link" }));
    expect(drawer().open).toBe(true);
    fireEvent.click(screen.getByRole("link", { name: "Usage" }));
    expect(drawer().open).toBe(false);
    expect(document.activeElement).toBe(opener);
  });

  it("passes its element to a ref", () => {
    const ref = vi.fn();
    render(
      <Drawer open={false} label="Navigation" closeLabel="Close" onClose={() => {}} ref={ref}>
        x
      </Drawer>,
    );
    expect(ref).toHaveBeenCalledWith(expect.any(HTMLDialogElement));
  });
});

function HandleHarness({ onChange }: { onChange?: (value: number) => void }) {
  const [value, setValue] = useState(240);
  return (
    <ResizeHandle
      label="Resize sidebar"
      value={value}
      min={200}
      max={400}
      fromPointer={(x) => x - 10}
      onChange={(next) => {
        onChange?.(next);
        setValue(next);
      }}
    />
  );
}

describe("ResizeHandle", () => {
  it("is a focusable vertical separator with its value and limits", async () => {
    const { container } = render(<HandleHarness />);
    const handle = screen.getByRole("separator", { name: "Resize sidebar" });
    expect(handle.getAttribute("aria-orientation")).toBe("vertical");
    expect(handle.getAttribute("aria-valuenow")).toBe("240");
    expect(handle.getAttribute("aria-valuemin")).toBe("200");
    expect(handle.getAttribute("aria-valuemax")).toBe("400");
    expect(handle.tabIndex).toBe(0);
    expect(await axeViolations(container)).toEqual([]);
  });

  it("resizes with the arrow keys, Shift for bigger steps, and Home and End, within the limits", () => {
    render(<HandleHarness />);
    const handle = screen.getByRole("separator");
    const value = () => handle.getAttribute("aria-valuenow");
    fireEvent.keyDown(handle, { key: "ArrowRight" });
    expect(value()).toBe("256");
    fireEvent.keyDown(handle, { key: "ArrowLeft", shiftKey: true });
    expect(value()).toBe("200");
    fireEvent.keyDown(handle, { key: "End" });
    expect(value()).toBe("400");
    fireEvent.keyDown(handle, { key: "ArrowRight" });
    expect(value()).toBe("400");
    fireEvent.keyDown(handle, { key: "Home" });
    expect(value()).toBe("200");
    fireEvent.keyDown(handle, { key: "a" });
    expect(value()).toBe("200");
  });

  it("follows a dragging pointer and ignores moves without a press", () => {
    const onChange = vi.fn();
    render(<HandleHarness onChange={onChange} />);
    const handle = screen.getByRole("separator");
    fireEvent.pointerMove(handle, { clientX: 300 });
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.pointerDown(handle, { button: 2, clientX: 250 });
    fireEvent.pointerMove(handle, { clientX: 300 });
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.pointerDown(handle, { button: 0, clientX: 250 });
    expect(document.activeElement).toBe(handle);
    fireEvent.pointerMove(handle, { clientX: 310 });
    expect(handle.getAttribute("aria-valuenow")).toBe("300");
    fireEvent.pointerMove(handle, { clientX: 1000 });
    expect(handle.getAttribute("aria-valuenow")).toBe("400");
    fireEvent.pointerUp(handle);
    fireEvent.pointerMove(handle, { clientX: 260 });
    expect(handle.getAttribute("aria-valuenow")).toBe("400");
    fireEvent.pointerDown(handle, { button: 0 });
    fireEvent.pointerCancel(handle);
    fireEvent.pointerMove(handle, { clientX: 260 });
    expect(handle.getAttribute("aria-valuenow")).toBe("400");
  });
});
