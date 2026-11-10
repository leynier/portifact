// The "Create issue" dialog of a thread (premium plan T7, decision 0018): the owner side picks a
// connection and a repository or team, edits the title (prefilled with the artifact's name) and
// chooses what goes into the issue. The link and the artifact's name are on by default; the
// quoted text and the first message are other people's words and are off until the person turns
// them on. The preview is built by the domain's `issueBody`, the same function the jobs Worker
// sends with, so it shows exactly what leaves Portifact. For an owner in the EU it says the text
// leaves the EU.
import {
  type AnnotationThreadView,
  INTEGRATION_LIMITS,
  type IntegrationChoice,
  type IntegrationChoiceList,
  type IssueParts,
} from "@portifact/contracts";
import { anchorQuote, issueBody, issueTitle, plainLine, threadLink } from "@portifact/domain";
import { Button, Callout, Checkbox, Select, Sheet, TextArea, TextInput } from "@portifact/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CircleAlert, Globe, SquarePlus } from "lucide-react";
import { type FormEvent, useEffect, useState } from "react";
import { useAnnounce, useDashboard, useT } from "../context.tsx";
import { errorMessage } from "../screens/artifact-list.tsx";
import { integrationChoicesQuery } from "../screens/integrations.tsx";
import { threadsQuery } from "./use-threads.ts";

const DEFAULT_PARTS: IssueParts = { link: true, artifactName: true, quote: false, message: false };

/**
 * The connections of the artifact's owner, for the owner side only (`enabled`): the artifact's
 * space first, then its connections. Undefined while loading, refused or not offered, so the
 * card offers nothing.
 */
export function useIssueChoices(artifactId: string, enabled: boolean) {
  const { api } = useDashboard();
  const artifact = useQuery({
    queryKey: ["artifact", artifactId, "owner"],
    queryFn: () => api.getArtifact(artifactId),
    enabled,
    staleTime: 5 * 60_000,
  });
  const owner = artifact.data?.owner;
  const slug = owner?.kind === "workspace" ? owner.slug : undefined;
  const choices = useQuery({
    queryKey: integrationChoicesQuery(slug),
    queryFn: () => api.integrations(slug),
    enabled: enabled && owner !== undefined,
    staleTime: 60_000,
  });
  return choices.data?.serviceAvailable ? choices.data : undefined;
}

/** The connections an issue can go through now. */
export function usableConnections(list: IntegrationChoiceList | undefined): IntegrationChoice[] {
  if (!list?.serviceAvailable || !list.available) return [];
  return list.connections.filter(
    (connection) => connection.usable && connection.targets.length > 0,
  );
}

export interface CreateIssueDialogProps {
  open: boolean;
  onClose(): void;
  artifactId: string;
  artifactName: string;
  thread: AnnotationThreadView;
  number: number;
  choices: IntegrationChoiceList;
}

export function CreateIssueDialog({
  open,
  onClose,
  artifactId,
  artifactName,
  thread,
  number,
  choices,
}: CreateIssueDialogProps) {
  const t = useT();
  const announce = useAnnounce();
  const queryClient = useQueryClient();
  const { api } = useDashboard();
  const usable = usableConnections(choices);
  const [connectionId, setConnectionId] = useState(usable[0]?.id ?? "");
  const connection = usable.find((one) => one.id === connectionId) ?? usable[0];
  const [target, setTarget] = useState(connection?.targets[0]?.id ?? "");
  const [title, setTitle] = useState(
    () => plainLine(artifactName, INTEGRATION_LIMITS.titleMax) ?? "",
  );
  const [parts, setParts] = useState<IssueParts>(DEFAULT_PARTS);
  // One key per opening: a retry of the same request never creates a second issue.
  const [key, setKey] = useState(() => crypto.randomUUID());
  useEffect(() => {
    if (open) setKey(crypto.randomUUID());
  }, [open]);

  const quote = anchorQuote(thread.target);
  const first = thread.messages[0];
  const message = first && first.state === "visible" ? first.body : null;
  const service = connection?.service ?? "github";
  const preview = issueBody(
    {
      service,
      link: threadLink(window.location.origin, artifactId, thread.path, thread.id),
      artifactName,
      quote,
      message,
      reference: "ti_…",
    },
    parts,
  );

  // The title as it goes out: inert, the same function the request applies.
  const checkedTitle = issueTitle(title);
  const sentTitle = checkedTitle.ok ? checkedTitle.value : "";
  const create = useMutation({
    mutationFn: () =>
      api.createThreadIssue(
        artifactId,
        thread.id,
        { connectionId: connection?.id ?? "", target, title: title.trim(), include: parts },
        key,
      ),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: threadsQuery(artifactId) });
      announce(t("issues.requested"));
      onClose();
    },
  });
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!connection || title.trim() === "") return;
    create.mutate();
  };
  const toggle = (part: keyof IssueParts) => (event: { currentTarget: HTMLInputElement }) => {
    const on = event.currentTarget.checked;
    setParts((current) => ({ ...current, [part]: on }));
  };
  const formId = `issue-${thread.id}`;

  return (
    <Sheet
      open={open}
      title={t("issues.dialog.title", { number })}
      closeLabel={t("issues.dialog.close")}
      onClose={onClose}
      footer={
        connection ? (
          <Button
            type="submit"
            form={formId}
            intent="primary"
            icon={<SquarePlus className="size-4" />}
            busy={create.isPending}
            disabled={title.trim() === ""}
          >
            {t("issues.dialog.submit")}
          </Button>
        ) : undefined
      }
    >
      {connection ? (
        <form id={formId} className="flex flex-col gap-5" onSubmit={submit} noValidate>
          {choices.euResidency ? (
            <Callout
              tone="info"
              title={t("issues.dialog.eu", { service: t(`integrations.service.${service}`) })}
              icon={<Globe className="size-5" />}
            />
          ) : null}
          <Select
            label={t("issues.dialog.connection")}
            value={connection.id}
            options={usable.map((one) => ({
              value: one.id,
              label: `${one.label} (${t(`integrations.service.${one.service}`)})`,
            }))}
            onChange={(id) => {
              setConnectionId(id);
              setTarget(usable.find((one) => one.id === id)?.targets[0]?.id ?? "");
            }}
          />
          <Select
            label={t("issues.dialog.target")}
            value={target}
            options={connection.targets.map((one) => ({ value: one.id, label: one.name }))}
            onChange={setTarget}
          />
          <TextInput
            label={t("issues.dialog.issueTitle")}
            required
            maxLength={INTEGRATION_LIMITS.titleMax}
            value={title}
            onChange={(event) => setTitle(event.currentTarget.value)}
          />
          <fieldset className="flex flex-col gap-3">
            <legend className="mb-1 text-sm font-medium">{t("issues.dialog.parts")}</legend>
            <Checkbox
              label={t("issues.dialog.part.link")}
              checked={parts.link}
              onChange={toggle("link")}
            />
            <Checkbox
              label={t("issues.dialog.part.artifactName")}
              checked={parts.artifactName}
              onChange={toggle("artifactName")}
            />
            {quote !== null ? (
              <Checkbox
                label={t("issues.dialog.part.quote")}
                description={t("issues.dialog.part.quoteHint")}
                checked={parts.quote}
                onChange={toggle("quote")}
              />
            ) : null}
            {message !== null ? (
              <Checkbox
                label={t("issues.dialog.part.message")}
                description={t("issues.dialog.part.messageHint")}
                checked={parts.message}
                onChange={toggle("message")}
              />
            ) : null}
          </fieldset>
          <TextArea
            label={t("issues.dialog.preview")}
            description={t("issues.dialog.previewHint")}
            code
            readOnly
            rows={8}
            value={`${sentTitle}\n\n${preview}`}
          />
          <p className="text-sm text-text-muted">{t("issues.dialog.never")}</p>
          <p className="text-sm text-text-muted">{t("issues.dialog.visible")}</p>
          {create.isError ? (
            <Callout
              tone="error"
              title={t("integrations.actionFailed")}
              icon={<CircleAlert className="size-5" />}
            >
              {errorMessage(t, create.error)}
            </Callout>
          ) : null}
        </form>
      ) : (
        <p className="text-sm">{t("issues.dialog.noConnections")}</p>
      )}
    </Sheet>
  );
}
