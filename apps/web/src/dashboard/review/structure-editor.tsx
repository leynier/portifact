// The structure panel of Suggest mode (decision 0027, delivery 4): the person picked an element in
// the frame and here chooses to move it (before or after another element of the page, picked in
// the frame in its own epoch), duplicate it or remove it; checks exactly what is saved, with the
// built preview, and saves it as a suggestion (or, on the owner side, adds it to their draft).
// Structure is never applied automatically: an accepted one goes to the change list. Nothing is
// sent to the frame but the pick's mode, and both elements' tags and texts came from the frame,
// so they are drawn only through the typed display.
import type { DraftEdit, Edit, EditOperation, ReviewStart } from "@portifact/contracts";
import { Button, RadioGroup, Tabs, TextArea } from "@portifact/ui";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Check, Crosshair } from "lucide-react";
import { type Dispatch, type KeyboardEvent, useEffect, useRef, useState } from "react";
import { useAnnounce, useDashboard, useT } from "../context.tsx";
import { useHumanCheck } from "./human-check.tsx";
import { ElementName, elementOf } from "./style-editor.tsx";
import {
  editOf,
  type StructureAction,
  type SuggestAction,
  type SuggestState,
} from "./suggest-session.ts";
import { UnsavedPreview } from "./suggestions.tsx";
import { ActionError, bodyError, humanRefusal } from "./thread-card.tsx";
import { applyThread, threadsQuery } from "./use-threads.ts";

type Element = { tag: string; label: string };

/** What a structure change does, in words, with both elements typed. */
export function StructureSummary({
  action,
  element,
  destination,
}: {
  action: StructureAction;
  element: Element;
  destination: { element: Element; place: "before" | "after" } | null;
}) {
  const t = useT();
  return (
    <ul aria-label={t("suggest.structure.summary")} className="flex flex-col gap-1 text-sm">
      <li>
        <ElementName element={element} />
      </li>
      <li>
        {action === "remove"
          ? t("suggest.structure.summary.remove")
          : action === "duplicate"
            ? t("suggest.structure.summary.duplicate")
            : destination?.place === "before"
              ? t("suggest.structure.summary.moveBefore")
              : t("suggest.structure.summary.moveAfter")}
      </li>
      {action === "move" && destination ? (
        <li>
          <ElementName element={destination.element} />
        </li>
      ) : null}
    </ul>
  );
}

/**
 * The structure panel: the picked element, the action, for a move its destination (picked in the
 * frame) and side, the note, then the check of exactly what Save sends with its preview. Escape
 * cancels; while the destination is being picked, the frame's Escape ends only that pick.
 */
export function StructureEditor({
  start,
  state,
  dispatch,
  humanNeeded,
  onClose,
  draft,
}: {
  start: ReviewStart;
  state: Extract<SuggestState, { mode: "structuring" }>;
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
  const destination = state.destination
    ? { element: elementOf(state.destination.anchor), place: state.place }
    : null;

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
      const field = panel.current?.querySelector<HTMLElement>("input");
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
  const pickDestination = () => {
    dispatch({ type: "destination-pick", on: !state.choosing });
    if (!state.choosing) announce(t("suggest.structure.destination.started"));
  };
  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key === "Escape" && !event.defaultPrevented) {
      event.preventDefault();
      cancel();
    }
  };

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: Escape works from every control inside
    <div ref={panel} className="flex flex-col gap-3" onKeyDown={onKeyDown}>
      <h2 className="text-base font-semibold">
        {state.reviewing
          ? t("suggest.editor.reviewTitle")
          : draft
            ? t("draft.structure.title")
            : t("suggest.structure.title")}
      </h2>
      <p className="text-sm text-text-muted">
        <ElementName element={element} />
      </p>
      <p className="text-sm text-text-muted">{t("suggest.structure.never")}</p>
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
                panel: (
                  <StructureSummary
                    action={state.action}
                    element={element}
                    destination={destination}
                  />
                ),
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
          <RadioGroup
            legend={t("suggest.structure.action")}
            name={`structure-action-${state.opened}`}
            value={state.action}
            onChange={(action) => dispatch({ type: "structure-action", action })}
            options={(["move", "duplicate", "remove"] as const).map((action) => ({
              value: action,
              label: t(`suggest.structure.action.${action}`),
              description: t(`suggest.structure.action.${action}.hint`),
            }))}
          />
          {state.action === "move" ? (
            <div className="flex flex-col gap-2">
              <p className="text-sm font-semibold">{t("suggest.structure.destination.label")}</p>
              <p className="text-sm">
                {destination ? (
                  <ElementName element={destination.element} />
                ) : (
                  t("suggest.structure.destination.none")
                )}
              </p>
              <div>
                <Button
                  size="sm"
                  icon={<Crosshair className="size-4" />}
                  aria-pressed={state.choosing}
                  onClick={pickDestination}
                >
                  {t("suggest.structure.destination.pick")}
                </Button>
              </div>
              <RadioGroup
                legend={t("suggest.structure.place")}
                name={`structure-place-${state.opened}`}
                layout="row"
                value={state.place}
                onChange={(place) => dispatch({ type: "place", place })}
                options={[
                  { value: "before", label: t("suggest.structure.place.before") },
                  { value: "after", label: t("suggest.structure.place.after") },
                ]}
              />
            </div>
          ) : null}
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
            <Button intent="primary" disabled={edit === null || state.choosing} onClick={review}>
              {t("suggest.editor.review")}
            </Button>
          </div>
        </>
      )}
    </div>
  );
}
