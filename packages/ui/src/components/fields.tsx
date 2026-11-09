// Form controls with their label, description and error wired for assistive technology. Screens
// use them through the form hook in ../forms, which binds them to TanStack Form fields.
import { CircleAlert } from "lucide-react";
import {
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
  useId,
} from "react";

type NativeInput = Omit<InputHTMLAttributes<HTMLInputElement>, "className" | "id" | "type">;

/** IDs of the hint and error under a control, for `aria-describedby`. */
function describedBy(...ids: (string | false | undefined)[]): string | undefined {
  const joined = ids.filter(Boolean).join(" ");
  return joined || undefined;
}

function FieldError({ id, children }: { id: string; children: string }) {
  return (
    <p id={id} className="flex items-center gap-1.5 text-sm font-semibold text-text">
      <CircleAlert aria-hidden="true" className="size-4 shrink-0" />
      {children}
    </p>
  );
}

export interface TextInputProps extends NativeInput {
  label: string;
  /** A hint under the label, read with the control. */
  description?: ReactNode;
  /** The validation message; marks the control invalid. */
  error?: string | undefined;
  type?: "text" | "email" | "search" | "url";
}

/** A labelled single-line text input. The label is always visible; placeholders are not labels. */
export function TextInput({ label, description, error, type = "text", ...rest }: TextInputProps) {
  const id = useId();
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-sm font-medium">
        {label}
      </label>
      {description ? (
        <p id={hintId} className="text-sm text-text-muted">
          {description}
        </p>
      ) : null}
      <input
        {...rest}
        id={id}
        type={type}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy(description !== undefined && hintId, error && errorId)}
        className="h-10 w-full rounded-sm border border-border-strong bg-canvas px-3 text-sm text-text transition-colors duration-150 placeholder:text-text-muted hover:border-text disabled:opacity-55 disabled:hover:border-border-strong aria-invalid:border-2 aria-invalid:border-text"
      />
      {error ? <FieldError id={errorId}>{error}</FieldError> : null}
    </div>
  );
}

export interface TextAreaProps
  extends Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, "className" | "id"> {
  label: string;
  description?: ReactNode;
  error?: string | undefined;
  /** Monospaced text with no wrapping changes, for source code and plain text. */
  code?: boolean;
}

/** A labelled multi-line text input, tall enough to edit a document. */
export function TextArea({ label, description, error, code = false, ...rest }: TextAreaProps) {
  const id = useId();
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-sm font-medium">
        {label}
      </label>
      {description ? (
        <p id={hintId} className="text-sm text-text-muted">
          {description}
        </p>
      ) : null}
      <textarea
        rows={16}
        spellCheck={!code}
        {...rest}
        id={id}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy(description !== undefined && hintId, error && errorId)}
        className={`min-h-48 w-full resize-y rounded-sm border border-border-strong bg-canvas p-3 text-sm text-text transition-colors duration-150 hover:border-text disabled:opacity-55 aria-invalid:border-2 aria-invalid:border-text ${code ? "font-mono leading-6" : "leading-6"}`}
      />
      {error ? <FieldError id={errorId}>{error}</FieldError> : null}
    </div>
  );
}

export interface SelectOption<T extends string = string> {
  value: T;
  label: string;
}

export interface SelectProps<T extends string = string>
  extends Omit<
    SelectHTMLAttributes<HTMLSelectElement>,
    "className" | "id" | "value" | "onChange" | "multiple" | "children"
  > {
  label: string;
  description?: ReactNode;
  error?: string | undefined;
  value: T;
  options: readonly SelectOption<T>[];
  onChange(value: T): void;
}

/**
 * One choice among many in a native select, so the browser and assistive technology provide
 * the keyboard and the list. Use a radio group instead when every option needs explaining.
 */
export function Select<T extends string = string>({
  label,
  description,
  error,
  value,
  options,
  onChange,
  ...rest
}: SelectProps<T>) {
  const id = useId();
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-sm font-medium">
        {label}
      </label>
      {description ? (
        <p id={hintId} className="text-sm text-text-muted">
          {description}
        </p>
      ) : null}
      <select
        {...rest}
        id={id}
        value={value}
        onChange={(event) => {
          const chosen = options.find((option) => option.value === event.target.value);
          if (chosen) onChange(chosen.value);
        }}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy(description !== undefined && hintId, error && errorId)}
        className="h-10 w-full rounded-sm border border-border-strong bg-canvas px-3 text-sm text-text transition-colors duration-150 placeholder:text-text-muted hover:border-text disabled:opacity-55 disabled:hover:border-border-strong aria-invalid:border-2 aria-invalid:border-text"
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
      {error ? <FieldError id={errorId}>{error}</FieldError> : null}
    </div>
  );
}

export interface CheckboxProps extends NativeInput {
  label: string;
  description?: ReactNode;
}

/** A native checkbox with its label beside it and an optional hint. */
export function Checkbox({ label, description, ...rest }: CheckboxProps) {
  const id = useId();
  const hintId = `${id}-hint`;
  return (
    <div className="flex items-start gap-3">
      <input
        {...rest}
        id={id}
        type="checkbox"
        aria-describedby={description ? hintId : undefined}
        className="mt-0.5 size-5 shrink-0 accent-text disabled:opacity-60"
      />
      <div className="min-w-0">
        <label htmlFor={id} className="text-sm font-medium">
          {label}
        </label>
        {description ? (
          <p id={hintId} className="text-sm text-text-muted">
            {description}
          </p>
        ) : null}
      </div>
    </div>
  );
}

export interface RadioOption<T extends string> {
  value: T;
  label: string;
  description?: ReactNode;
  disabled?: boolean;
}

export interface RadioGroupProps<T extends string> {
  /** The question the options answer, read as the group's name. */
  legend: string;
  name: string;
  value: T;
  options: readonly RadioOption<T>[];
  onChange(value: T): void;
  onBlur?(): void;
  disabled?: boolean;
  /** `row` puts the options side by side on wide screens, for short ones such as types. */
  layout?: "stack" | "row";
}

/**
 * One choice among a few, as native radio buttons in a fieldset, so arrow keys move between
 * options. The chosen option has a heavier border as well as the checked control.
 */
export function RadioGroup<T extends string>({
  legend,
  name,
  value,
  options,
  onChange,
  onBlur,
  disabled = false,
  layout = "stack",
}: RadioGroupProps<T>) {
  const id = useId();
  return (
    <fieldset disabled={disabled} className="min-w-0">
      <legend className="mb-3 text-sm font-semibold">{legend}</legend>
      <div className={layout === "row" ? "grid gap-2.5 sm:grid-cols-3" : "flex flex-col gap-2.5"}>
        {options.map((option) => {
          const optionId = `${id}-${option.value}`;
          const hintId = `${optionId}-hint`;
          return (
            <div
              key={option.value}
              className="flex items-start gap-3 rounded-sm border border-border bg-canvas p-3.5 transition-colors duration-150 hover:bg-surface has-checked:border-transparent has-checked:selection-band has-disabled:hover:bg-canvas"
            >
              <input
                id={optionId}
                type="radio"
                name={name}
                value={option.value}
                checked={value === option.value}
                disabled={option.disabled}
                onChange={() => onChange(option.value)}
                onBlur={onBlur}
                aria-describedby={option.description ? hintId : undefined}
                className="mt-0.5 size-5 shrink-0 accent-text disabled:opacity-60"
              />
              <div className="min-w-0">
                <label htmlFor={optionId} className="text-sm font-medium">
                  {option.label}
                </label>
                {option.description ? (
                  <div id={hintId} className="text-sm text-text-muted">
                    {option.description}
                  </div>
                ) : null}
              </div>
            </div>
          );
        })}
      </div>
    </fieldset>
  );
}
