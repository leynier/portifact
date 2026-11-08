// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { axeViolations } from "../testing/axe.ts";
import { firstError, revalidateLogic, useAppForm } from "./index.tsx";

afterEach(cleanup);

interface Values {
  email: string;
  notes: string;
  mode: "a" | "b";
  indexable: boolean;
  kind: string;
}

function Example({ onSubmit }: { onSubmit(values: Values): Promise<void> | void }) {
  const form = useAppForm({
    defaultValues: { email: "", notes: "", mode: "a", indexable: false, kind: "any" } as Values,
    validationLogic: revalidateLogic(),
    validators: {
      onDynamic: ({ value }) =>
        value.email.includes("@")
          ? undefined
          : { fields: { email: "Enter a valid email address" } },
    },
    onSubmit: ({ value }) => onSubmit(value),
  });
  return (
    <form.AppForm>
      <form.Form label="Example">
        <form.AppField name="email">{(field) => <field.TextField label="Email" />}</form.AppField>
        <form.AppField name="notes">
          {(field) => <field.TextAreaField label="Notes" />}
        </form.AppField>
        <form.AppField name="mode">
          {(field) => (
            <field.RadioGroupField
              legend="Mode"
              options={[
                { value: "a", label: "A" },
                { value: "b", label: "B" },
              ]}
            />
          )}
        </form.AppField>
        <form.AppField name="indexable">
          {(field) => <field.CheckboxField label="Indexable" />}
        </form.AppField>
        <form.AppField name="kind">
          {(field) => (
            <field.SelectField
              label="Kind"
              options={[
                { value: "any", label: "Any" },
                { value: "site", label: "Site" },
              ]}
            />
          )}
        </form.AppField>
        <form.SubmitButton>Save</form.SubmitButton>
      </form.Form>
    </form.AppForm>
  );
}

describe("form hook", () => {
  it("submits the values of every bound field", async () => {
    const onSubmit = vi.fn();
    render(<Example onSubmit={onSubmit} />);
    expect(screen.getByRole("form", { name: "Example" })).toBeTruthy();
    fireEvent.change(screen.getByRole("textbox", { name: "Email" }), {
      target: { value: "ana@example.com" },
    });
    fireEvent.change(screen.getByRole("textbox", { name: "Notes" }), {
      target: { value: "line 1\nline 2" },
    });
    fireEvent.click(screen.getByRole("radio", { name: "B" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Indexable" }));
    fireEvent.change(screen.getByRole("combobox", { name: "Kind" }), {
      target: { value: "site" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(onSubmit).toHaveBeenCalledWith({
        email: "ana@example.com",
        notes: "line 1\nline 2",
        mode: "b",
        indexable: true,
        kind: "site",
      }),
    );
  });

  it("shows the error on submit, focuses the invalid field and clears it once fixed", async () => {
    const onSubmit = vi.fn();
    const { container } = render(<Example onSubmit={onSubmit} />);
    const email = screen.getByRole("textbox", { name: "Email" });
    // No error before the first submit, even after typing.
    fireEvent.change(email, { target: { value: "x" } });
    expect(email.hasAttribute("aria-invalid")).toBe(false);

    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(email.getAttribute("aria-invalid")).toBe("true"));
    expect(screen.getByText("Enter a valid email address")).toBeTruthy();
    expect(document.activeElement).toBe(email);
    expect(onSubmit).not.toHaveBeenCalled();
    expect(await axeViolations(container)).toEqual([]);

    fireEvent.change(email, { target: { value: "x@y.z" } });
    await waitFor(() => expect(email.hasAttribute("aria-invalid")).toBe(false));
  });

  it("keeps the submit button busy while the submit runs", async () => {
    let finish: () => void = () => {};
    render(<Example onSubmit={() => new Promise<void>((resolve) => (finish = resolve))} />);
    fireEvent.change(screen.getByRole("textbox", { name: "Email" }), {
      target: { value: "a@b.c" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    const button = screen.getByRole("button", { name: "Save" });
    await waitFor(() => expect(button.getAttribute("aria-busy")).toBe("true"));
    finish();
    await waitFor(() => expect(button.hasAttribute("aria-busy")).toBe(false));
  });
});

describe("firstError", () => {
  it("reads strings and schema issues and skips empty ones", () => {
    expect(firstError([])).toBeUndefined();
    expect(firstError([undefined, "", "First", "Second"])).toBe("First");
    expect(firstError([{ message: "" }, { message: "From a schema" }])).toBe("From a schema");
    expect(firstError([null, 3, { code: "x" }])).toBeUndefined();
  });
});
