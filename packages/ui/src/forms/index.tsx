// The one form hook of the product (docs/design.md, "Forms"): TanStack Form with the design
// system's fields bound once, so screens never wire values, labels, errors or ARIA by hand.
//
//   const form = useAppForm({ defaultValues, validators, onSubmit });
//   <form.AppForm>
//     <form.Form label="...">
//       <form.AppField name="email">{(field) => <field.TextField label="Email" />}</form.AppField>
//       <form.SubmitButton>Add</form.SubmitButton>
//     </form.Form>
//   </form.AppForm>
import { createFormHook, createFormHookContexts } from "@tanstack/react-form";
import { type ReactNode, useRef } from "react";
import { Button } from "../components/button.tsx";
import {
  Checkbox,
  type CheckboxProps,
  RadioGroup as RadioGroupControl,
  type RadioGroupProps,
  SearchField as SearchFieldControl,
  type SearchFieldProps,
  TextArea,
  type TextAreaProps,
  TextInput,
  type TextInputProps,
} from "../components/fields.tsx";
import { Select, type SelectProps } from "../components/select.tsx";

export { revalidateLogic } from "@tanstack/react-form";

const { fieldContext, formContext, useFieldContext, useFormContext } = createFormHookContexts();

/** The message to show for a field: the first error, whether a string or a schema issue. */
export function firstError(errors: readonly unknown[]): string | undefined {
  for (const error of errors) {
    if (typeof error === "string" && error) return error;
    if (typeof error === "object" && error !== null && "message" in error) {
      const { message } = error;
      if (typeof message === "string" && message) return message;
    }
  }
  return undefined;
}

type Bound<P> = Omit<P, "name" | "value" | "checked" | "onChange" | "onBlur" | "error">;

function TextField(props: Bound<TextInputProps>) {
  const field = useFieldContext<string>();
  return (
    <TextInput
      {...props}
      name={field.name}
      value={field.state.value}
      onChange={(event) => field.handleChange(event.target.value)}
      onBlur={field.handleBlur}
      error={firstError(field.state.meta.errors)}
    />
  );
}

/** A search box; clearing it empties the field and submits the form, so the search ends. */
function SearchField(props: Omit<Bound<SearchFieldProps>, "onClear">) {
  const field = useFieldContext<string>();
  const form = useFormContext();
  return (
    <SearchFieldControl
      {...props}
      name={field.name}
      value={field.state.value}
      onChange={(event) => field.handleChange(event.target.value)}
      onBlur={field.handleBlur}
      onClear={() => {
        field.handleChange("");
        void form.handleSubmit();
      }}
      error={firstError(field.state.meta.errors)}
    />
  );
}

function TextAreaField(props: Bound<TextAreaProps>) {
  const field = useFieldContext<string>();
  return (
    <TextArea
      {...props}
      name={field.name}
      value={field.state.value}
      onChange={(event) => field.handleChange(event.target.value)}
      onBlur={field.handleBlur}
      error={firstError(field.state.meta.errors)}
    />
  );
}

function CheckboxField(props: Bound<CheckboxProps>) {
  const field = useFieldContext<boolean>();
  return (
    <Checkbox
      {...props}
      name={field.name}
      checked={field.state.value}
      onChange={(event) => field.handleChange(event.target.checked)}
      onBlur={field.handleBlur}
    />
  );
}

function RadioGroupField(props: Bound<RadioGroupProps<string>>) {
  const field = useFieldContext<string>();
  return (
    <RadioGroupControl
      {...props}
      name={field.name}
      value={field.state.value}
      onChange={field.handleChange}
      onBlur={field.handleBlur}
    />
  );
}

function SelectField(props: Bound<SelectProps<string>>) {
  const field = useFieldContext<string>();
  return (
    <Select
      {...props}
      name={field.name}
      value={field.state.value}
      onChange={field.handleChange}
      onBlur={field.handleBlur}
      error={firstError(field.state.meta.errors)}
    />
  );
}

export interface FormProps {
  /** Accessible name of the form, when it has no visible heading of its own. */
  label?: string;
  children: ReactNode;
}

/**
 * The form element. It submits through TanStack Form and, when validation fails, moves focus
 * to the first invalid control, whose error is linked to it and read out.
 */
function Form({ label, children }: FormProps) {
  const form = useFormContext();
  const ref = useRef<HTMLFormElement>(null);
  return (
    <form
      ref={ref}
      noValidate
      aria-label={label}
      onSubmit={async (event) => {
        event.preventDefault();
        event.stopPropagation();
        await form.handleSubmit();
        if (!form.state.isValid) {
          ref.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus();
        }
      }}
    >
      {children}
    </form>
  );
}

export interface SubmitButtonProps {
  children: ReactNode;
  icon?: ReactNode;
  /** Busy for work that outlives the submit handler, such as a mutation still running. */
  busy?: boolean;
  disabled?: boolean;
  intent?: "primary" | "secondary";
  /** `sm` for compact forms, such as a composer floating over content. */
  size?: "md" | "sm";
}

/** The submit button, busy while the form submits. */
function SubmitButton({
  children,
  icon,
  busy = false,
  disabled,
  intent = "primary",
  size = "md",
}: SubmitButtonProps) {
  const form = useFormContext();
  return (
    <form.Subscribe selector={(state) => state.isSubmitting}>
      {(submitting) => (
        <Button
          type="submit"
          intent={intent}
          size={size}
          icon={icon}
          busy={submitting || busy}
          disabled={disabled}
        >
          {children}
        </Button>
      )}
    </form.Subscribe>
  );
}

export const { useAppForm, withForm } = createFormHook({
  fieldContext,
  formContext,
  fieldComponents: {
    TextField,
    SearchField,
    TextAreaField,
    CheckboxField,
    RadioGroupField,
    SelectField,
  },
  formComponents: { Form, SubmitButton },
});
