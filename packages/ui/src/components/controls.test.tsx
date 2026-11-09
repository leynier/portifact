// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { createRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { axeViolations } from "../testing/axe.ts";
import { Avatar, initialOf } from "./avatar.tsx";
import { Button } from "./button.tsx";
import { IconButton, IconLink } from "./icon-button.tsx";
import { Menu } from "./menu.tsx";
import { Tooltip } from "./tooltip.tsx";

afterEach(cleanup);

const Icon = () => <svg data-testid="icon" />;

describe("Tooltip", () => {
  it("shows its label on hover and on keyboard focus, and hides on leave, blur, press and Escape", () => {
    render(
      <Tooltip label="Copy link">
        <button type="button" aria-label="Copy link">
          <Icon />
        </button>
      </Tooltip>,
    );
    const button = screen.getByRole("button", { name: "Copy link" });
    const shown = () => button.parentElement?.querySelector('[aria-hidden="true"]');
    expect(shown()).toBeNull();
    fireEvent.pointerEnter(button);
    expect(shown()?.textContent).toBe("Copy link");
    fireEvent.pointerLeave(button);
    expect(shown()).toBeNull();
    fireEvent.focus(button);
    expect(shown()).not.toBeNull();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(shown()).toBeNull();
    fireEvent.focus(button);
    fireEvent.blur(button);
    expect(shown()).toBeNull();
    fireEvent.pointerEnter(button);
    fireEvent.pointerDown(button);
    expect(shown()).toBeNull();
  });

  it("stays hidden while asked to", () => {
    render(
      <Tooltip label="More" hidden>
        <button type="button">More</button>
      </Tooltip>,
    );
    const button = screen.getByRole("button", { name: "More" });
    fireEvent.pointerEnter(button);
    expect(button.parentElement?.querySelector('[aria-hidden="true"]')).toBeNull();
  });
});

describe("IconButton and IconLink", () => {
  it("are named by their label, which their tooltip shows, and run or link", async () => {
    const onClick = vi.fn();
    const { container } = render(
      <>
        <IconButton label="Copy link" icon={<Icon />} onClick={onClick} aria-pressed={false} />
        <IconLink label="Your artifacts" icon={<Icon />} href="/" size="md" align="end" />
      </>,
    );
    const button = screen.getByRole("button", { name: "Copy link" });
    expect(button.getAttribute("type")).toBe("button");
    fireEvent.click(button);
    expect(onClick).toHaveBeenCalledTimes(1);
    fireEvent.focus(button);
    expect(button.parentElement?.textContent).toBe("Copy link");
    const link = screen.getByRole("link", { name: "Your artifacts" });
    expect(link.getAttribute("href")).toBe("/");
    for (const icon of screen.getAllByTestId("icon")) {
      expect(icon.parentElement?.getAttribute("aria-hidden")).toBe("true");
    }
    expect(await axeViolations(container)).toEqual([]);
  });

  it("is disabled and marked busy while its action runs", () => {
    render(<IconButton label="Resolve" icon={<Icon />} busy />);
    const button = screen.getByRole("button", { name: "Resolve" }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(button.getAttribute("aria-busy")).toBe("true");
  });
});

describe("Menu", () => {
  const setup = () => {
    const edit = vi.fn();
    const remove = vi.fn();
    const utils = render(
      <div>
        <Menu
          label="More actions for thread 1"
          items={[
            { id: "edit", label: "Edit", icon: <Icon />, onSelect: edit },
            { id: "delete", label: "Delete thread", onSelect: remove },
            { id: "docs", label: "Help", href: "/help" },
          ]}
        />
        <p>Outside</p>
      </div>,
    );
    const trigger = screen.getByRole("button", { name: "More actions for thread 1" });
    return { edit, remove, trigger, ...utils };
  };

  it("opens a labelled menu, moves focus through its items and chooses one", async () => {
    const { edit, trigger, container } = setup();
    expect(trigger.getAttribute("aria-haspopup")).toBe("menu");
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(trigger);
    const menu = screen.getByRole("menu", { name: "More actions for thread 1" });
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    expect(trigger.getAttribute("aria-controls")).toBe(menu.id);
    const items = within(menu).getAllByRole("menuitem");
    expect(items.map((item) => item.textContent)).toEqual(["Edit", "Delete thread", "Help"]);
    expect(items[2]?.getAttribute("href")).toBe("/help");
    expect(document.activeElement).toBe(items[0]);
    expect(await axeViolations(container)).toEqual([]);
    fireEvent.keyDown(menu, { key: "ArrowDown" });
    expect(document.activeElement).toBe(items[1]);
    fireEvent.keyDown(menu, { key: "End" });
    expect(document.activeElement).toBe(items[2]);
    fireEvent.keyDown(menu, { key: "ArrowDown" });
    expect(document.activeElement).toBe(items[0]);
    fireEvent.keyDown(menu, { key: "ArrowUp" });
    expect(document.activeElement).toBe(items[2]);
    fireEvent.keyDown(menu, { key: "Home" });
    expect(document.activeElement).toBe(items[0]);
    vi.useFakeTimers();
    fireEvent.click(items[0] as HTMLElement);
    expect(edit).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("menu")).toBeNull();
    // Nothing else took focus, so it goes back to the button.
    act(() => vi.runAllTimers());
    expect(document.activeElement).toBe(trigger);
    vi.useRealTimers();
  });

  it("opens from the keyboard on the first or last item, and closes with Escape, Tab or a click outside", () => {
    const { trigger } = setup();
    fireEvent.keyDown(trigger, { key: "ArrowUp" });
    let items = screen.getAllByRole("menuitem");
    expect(document.activeElement).toBe(items[2]);
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
    expect(document.activeElement).toBe(trigger);

    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    items = screen.getAllByRole("menuitem");
    expect(document.activeElement).toBe(items[0]);
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Tab" });
    expect(screen.queryByRole("menu")).toBeNull();

    fireEvent.keyDown(trigger, { key: "Enter" });
    expect(screen.queryByRole("menu")).toBeNull();
    fireEvent.click(trigger);
    fireEvent.pointerDown(screen.getByRole("menuitem", { name: "Edit" }));
    expect(screen.getByRole("menu")).toBeTruthy();
    fireEvent.pointerDown(screen.getByText("Outside"));
    expect(screen.queryByRole("menu")).toBeNull();
    fireEvent.click(trigger);
    fireEvent.click(trigger);
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("leaves focus where the chosen action put it, and lends its button through a ref", () => {
    const ref = createRef<HTMLButtonElement>();
    const field = document.createElement("input");
    document.body.append(field);
    vi.useFakeTimers();
    render(
      <Menu
        label="Message actions"
        buttonRef={ref}
        items={[{ id: "edit", label: "Edit", onSelect: () => field.focus() }]}
      />,
    );
    expect(ref.current).toBe(screen.getByRole("button", { name: "Message actions" }));
    fireEvent.click(ref.current as HTMLButtonElement);
    fireEvent.click(screen.getByRole("menuitem", { name: "Edit" }));
    act(() => vi.runAllTimers());
    expect(document.activeElement).toBe(field);
    vi.useRealTimers();
    field.remove();
  });
});

describe("Avatar", () => {
  it("shows the first letter of a name, decoratively", () => {
    const { container } = render(<Avatar name="ada@example.com" size="md" />);
    const avatar = container.firstElementChild;
    expect(avatar?.textContent).toBe("A");
    expect(avatar?.getAttribute("aria-hidden")).toBe("true");
    expect(initialOf("  émile")).toBe("É");
    expect(initialOf("")).toBe("·");
  });
});

describe("Button extras", () => {
  it("shows a count that screen readers hear in words, and states a pressed toggle", async () => {
    const { container } = render(
      <Button aria-pressed count={{ value: 3, label: "(3 open threads)" }}>
        Comments
      </Button>,
    );
    const button = screen.getByRole("button", { name: "Comments (3 open threads)" });
    expect(button.getAttribute("aria-pressed")).toBe("true");
    expect(within(button).getByText("3").getAttribute("aria-hidden")).toBe("true");
    expect(await axeViolations(container)).toEqual([]);
  });

  it("looks like a field that opens a form in place", () => {
    const onClick = vi.fn();
    render(
      <Button intent="field" size="sm" onClick={onClick}>
        Reply
      </Button>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Reply" }));
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});
