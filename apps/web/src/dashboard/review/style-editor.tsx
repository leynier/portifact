// The style panel of Suggest mode (decision 0027, delivery 3): the person picked an element in the
// frame, and here chooses properties from the allowlist and their new values, checks exactly what
// is saved, with the built preview of it, and saves it as a suggestion (or, on the owner side, adds
// it to their draft). A style is never applied automatically: an accepted one goes to the change
// list. Nothing chosen here is sent to the frame, and the viewer never reads the page's computed
// style, so a change has no before. Everything about the element (its tag and text) came from the
// frame and is untrusted: it is drawn only through the typed display.
import {
  type DraftEdit,
  EDIT_LIMITS,
  type Edit,
  type EditOperation,
  type ElementAnchor,
  type ReviewStart,
  STYLE_KEYWORDS,
  STYLE_PROPERTY_NAMES,
  type StyleProperty,
} from "@portifact/contracts";
import { tokens } from "@portifact/domain/suggestion-display";
import { Button, Select, Tabs, TextArea, TextInput, TypedText } from "@portifact/ui";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Check, Plus, X } from "lucide-react";
import { type Dispatch, type KeyboardEvent, useEffect, useRef, useState } from "react";
import { useAnnounce, useDashboard, useT } from "../context.tsx";
import { useHumanCheck } from "./human-check.tsx";
import {
  editOf,
  type SuggestAction,
  type SuggestState,
  styleRowProblem,
} from "./suggest-session.ts";
import { TypedSentence, UnsavedPreview, useDiffLabels } from "./suggestions.tsx";
import { ActionError, bodyError, humanRefusal } from "./thread-card.tsx";
import { applyThread, threadsQuery } from "./use-threads.ts";

type T = ReturnType<typeof useT>;

const KEYWORD_PROPERTIES: Readonly<Record<string, readonly string[]>> = STYLE_KEYWORDS;
const isKnown = (property: string): property is StyleProperty =>
  (STYLE_PROPERTY_NAMES as readonly string[]).includes(property);

/** A property's name in the reader's language, or the property itself when this build lacks it. */
export const propertyLabel = (t: T, property: string): string =>
  isKnown(property) ? t(`suggest.style.property.${property}`) : property;

function valueHint(t: T, property: StyleProperty): string | undefined {
  switch (property) {
    case "color":
    case "background-color":
      return t("suggest.style.hint.color");
    case "font-size":
      return t("suggest.style.hint.fontSize");
    case "letter-spacing":
      return t("suggest.style.hint.letterSpacing");
    case "border-radius":
      return t("suggest.style.hint.borderRadius");
    default:
      return undefined;
  }
}

/** The element a style or structure change is about: its tag and its text, both untrusted. */
export function ElementName({ element }: { element: { tag: string; label: string } }) {
  const t = useT();
  return element.label === "" ? (
    <TypedSentence
      message={(fields) => t("suggest.style.elementEmpty", fields)}
      fields={{ tag: element.tag }}
    />
  ) : (
    <TypedSentence
      message={(fields) => t("suggest.style.element", fields)}
      fields={{ tag: element.tag, label: element.label }}
    />
  );
}

/** The element of an anchor, as an envelope describes it. */
export const elementOf = (anchor: ElementAnchor) => ({
  tag: anchor.tagName,
  label: anchor.fingerprint,
});

/** What a style change sets, property by property; values are untrusted text. */
export function StyleChanges({
  changes,
}: {
  changes: readonly { property: string; before: string | null; after: string }[];
}) {
  const t = useT();
  const labels = useDiffLabels();
  return (
    <ul aria-label={t("suggest.style.changes")} className="flex flex-col gap-1 text-sm">
      {changes.map((change, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: the changes keep their order
        <li key={index}>
          {change.before === null ? (
            <TypedSentence
              message={(fields) => t("suggest.style.change", fields)}
              fields={{ property: propertyLabel(t, change.property), after: change.after }}
            />
          ) : (
            <TypedSentence
              message={(fields) => t("suggest.style.changeFrom", fields)}
              fields={{
                property: propertyLabel(t, change.property),
                before: change.before,
                after: change.after,
              }}
            />
          )}
          {isKnown(change.property) ? null : (
            <TypedText
              tokens={tokens(change.property)}
              characterLabel={labels.character}
              empty={labels.empty}
            />
          )}
        </li>
      ))}
    </ul>
  );
}

/**
 * The style panel: the picked element, one row per property (a property and its new value, each
 * checked against the allowlist as it is typed), the note, then the check of exactly what Save
 * sends with its preview. Enter in a field reviews; Escape cancels.
 */
export function StyleEditor({
  start,
  state,
  dispatch,
  humanNeeded,
  onClose,
  draft,
}: {
  start: ReviewStart;
  state: Extract<SuggestState, { mode: "styling" }>;
  dispatch: Dispatch<SuggestAction>;
  humanNeeded: boolean;
  /** The owner side editing directly: Save adds the change to their draft, with no note. */
  draft?:
    | {
        add(operation: EditOperation): Promise<boolean>;
        editWith(operation: EditOperation): DraftEdit | null;
      }
    | undefined;
  onClose(threadId: string | null): void;
}) {
  const t = useT();
  const announce = useAnnounce();
  const queryClient = useQueryClient();
  const { api } = useDashboard();
  const human = useHumanCheck(humanNeeded);
  const panel = useRef<HTMLDivElement>(null);
  const [noteError, setNoteError] = useState<string | undefined>();
  const edit = editOf(state);
  const element = elementOf(state.target.anchor);

  const toDraft = useMutation({
    mutationFn: (value: Edit) => {
      const [operation] = value.operations;
      return draft && operation ? draft.add(operation) : Promise.resolve(false);
    },
    onSuccess: (added) => {
      if (!added) return;
      dispatch({ type: "saved" });
      onClose(null);
    },
  });
  const save = useMutation({
    mutationFn: (value: Edit) =>
      human.post((key, token) =>
        api.suggestions.submit(
          start.artifactId,
          {
            versionId: start.versionId,
            edit: value,
            body: state.note,
            ...(token === undefined ? {} : { turnstileToken: token }),
          },
          key,
        ),
      ),
    onSuccess: async (thread) => {
      if (!thread) return;
      applyThread(queryClient, start.artifactId, thread);
      dispatch({ type: "saved" });
      announce(t("suggest.saved"));
      onClose(thread.id);
      await queryClient.invalidateQueries({ queryKey: threadsQuery(start.artifactId) });
    },
  });

  useEffect(() => {
    // Placed (and so visible) only after it mounts: focus once more on the next frame.
    const focus = () => {
      const field = panel.current?.querySelector<HTMLElement>("input, button[role='combobox']");
      if (field && document.activeElement !== field) field.focus();
    };
    focus();
    const frame = requestAnimationFrame(focus);
    return () => cancelAnimationFrame(frame);
  }, []);

  const cancel = () => {
    dispatch({ type: "cancel" });
    onClose(null);
  };
  const commit = (value: Edit) => (draft ? toDraft.mutate(value) : save.mutate(value));
  const review = () => {
    if (draft) {
      dispatch({ type: "review" });
      return;
    }
    const error = bodyError(t, state.note)?.fields.body;
    setNoteError(error);
    if (!error) dispatch({ type: "review" });
  };
  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key === "Escape" && !event.defaultPrevented) {
      event.preventDefault();
      cancel();
      return;
    }
    if (
      event.key === "Enter" &&
      event.target instanceof HTMLInputElement &&
      !event.nativeEvent.isComposing
    ) {
      event.preventDefault();
      if (state.reviewing && edit) commit(edit);
      else if (edit) review();
    }
  };

  const rows = state.changes;
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: Escape and Enter work from every control inside
    <div ref={panel} className="flex flex-col gap-3" onKeyDown={onKeyDown}>
      <h2 className="text-base font-semibold">
        {state.reviewing
          ? t("suggest.editor.reviewTitle")
          : draft
            ? t("draft.style.title")
            : t("suggest.style.title")}
      </h2>
      <p className="text-sm text-text-muted">
        <ElementName element={element} />
      </p>
      <p className="text-sm text-text-muted">{t("suggest.style.never")}</p>
      {save.isError && !humanRefusal(save.error) ? <ActionError error={save.error} /> : null}
      {state.reviewing && edit ? (
        <>
          <p className="text-sm text-text-muted">{t("suggest.editor.reviewHint")}</p>
          <Tabs
            label={t("suggest.editor.tabs")}
            tabs={[
              {
                id: "change",
                label: t("suggest.editor.tabs.change"),
                panel: <StyleChanges changes={rows.map((row) => ({ ...row, before: null }))} />,
              },
              {
                id: "preview",
                label: t("suggest.tabs.preview"),
                panel: <UnsavedPreview start={start} edit={edit} draft={draft} />,
              },
            ]}
          />
          {human.field}
          <div className="flex flex-wrap justify-end gap-2">
            <Button onClick={() => dispatch({ type: "back" })}>{t("suggest.editor.back")}</Button>
            <Button
              intent="primary"
              icon={<Check className="size-4" />}
              busy={save.isPending || toDraft.isPending}
              onClick={() => commit(edit)}
            >
              {draft ? t("draft.add") : t("suggest.editor.save")}
            </Button>
          </div>
        </>
      ) : (
        <>
          <ol aria-label={t("suggest.style.changes")} className="flex flex-col gap-3">
            {rows.map((row, index) => {
              const number = index + 1;
              const problem = row.after === "" ? null : styleRowProblem(rows, index);
              const duplicate = styleRowProblem(rows, index) === "duplicate";
              const keywords = KEYWORD_PROPERTIES[row.property];
              const error = duplicate
                ? t("suggest.style.duplicate")
                : problem === "invalid"
                  ? t("suggest.style.invalid")
                  : undefined;
              return (
                // biome-ignore lint/suspicious/noArrayIndexKey: rows keep their order
                <li key={index} className="flex flex-col gap-2">
                  <Select
                    label={t("suggest.style.property", { number })}
                    value={row.property}
                    options={STYLE_PROPERTY_NAMES.map((property) => ({
                      value: property,
                      label: propertyLabel(t, property),
                    }))}
                    error={duplicate ? error : undefined}
                    onChange={(property) =>
                      dispatch({
                        type: "style",
                        index,
                        change: { property, after: KEYWORD_PROPERTIES[property]?.[0] ?? "" },
                      })
                    }
                  />
                  {keywords ? (
                    <Select
                      label={t("suggest.style.value", { number })}
                      value={keywords.includes(row.after) ? row.after : (keywords[0] as string)}
                      options={keywords.map((value) => ({ value, label: value }))}
                      onChange={(after) => dispatch({ type: "style", index, change: { after } })}
                    />
                  ) : (
                    <TextInput
                      label={t("suggest.style.value", { number })}
                      description={valueHint(t, row.property)}
                      value={row.after}
                      error={duplicate ? undefined : error}
                      autoComplete="off"
                      spellCheck={false}
                      onChange={(event) =>
                        dispatch({
                          type: "style",
                          index,
                          change: { after: event.target.value.trim().toLowerCase() },
                        })
                      }
                    />
                  )}
                  {rows.length > 1 ? (
                    <div>
                      <Button
                        size="sm"
                        intent="ghost"
                        icon={<X className="size-4" />}
                        aria-label={t("suggest.style.remove", { number })}
                        onClick={() => dispatch({ type: "style-remove", index })}
                      >
                        {t("suggest.style.removeShort")}
                      </Button>
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ol>
          <div>
            <Button
              size="sm"
              icon={<Plus className="size-4" />}
              disabled={rows.length >= EDIT_LIMITS.styleChangesMax}
              onClick={() => dispatch({ type: "style-add" })}
            >
              {t("suggest.style.add")}
            </Button>
          </div>
          {draft ? null : (
            <TextArea
              label={t("suggest.editor.note")}
              description={t("suggest.editor.noteHint")}
              value={state.note}
              onChange={(event) => {
                dispatch({ type: "note", note: event.target.value });
                setNoteError(undefined);
              }}
              error={noteError}
              rows={2}
              compact
            />
          )}
          <div className="flex flex-wrap justify-end gap-2">
            <Button onClick={cancel}>{t("suggest.editor.cancel")}</Button>
            <Button intent="primary" disabled={edit === null} onClick={review}>
              {t("suggest.editor.review")}
            </Button>
          </div>
        </>
      )}
    </div>
  );
}
