// "Data you shared" (`/shared-data`, decision 0026, "The grant"): the artifacts whose pages the
// person allowed to know them and save what they enter, with the grants still open, and a way to
// revoke them. Revoking applies within a minute everywhere the grant was used. What the person
// saved stays with the artifact; deleting or exporting it is the person's right on the artifact's
// own page. Names and hosts are untrusted text, rendered as text only.
import type { DataGrantView } from "@portifact/contracts";
import {
  Button,
  Callout,
  ConfirmDialog,
  EmptyState,
  LoadingState,
  PageHeader,
  RadioGroup,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeaderCell,
  TableRow,
} from "@portifact/ui";
import { useInfiniteQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { CircleAlert, Download, Mail, RotateCcw, Trash2, Unplug } from "lucide-react";
import { useState } from "react";
import { ApiFailure } from "../api.ts";
import { useAnnounce, useDashboard, useFormatDate, useT } from "../context.tsx";
import { safeFileName } from "../publish/download.ts";
import { useDocumentTitle } from "../use-document-title.ts";
import { errorMessage } from "./artifact-list.tsx";

export const DATA_GRANTS_QUERY = ["data-grants"] as const;

export function SharedDataScreen() {
  const t = useT();
  useDocumentTitle(t("sharedData.title"));
  const { api } = useDashboard();
  const grants = useInfiniteQuery({
    queryKey: DATA_GRANTS_QUERY,
    queryFn: ({ pageParam }) => api.dataGrants(pageParam),
    initialPageParam: null as string | null,
    getNextPageParam: (page) => page.next,
  });
  const items = grants.data?.pages.flatMap((page) => page.items) ?? [];
  return (
    <div className="flex flex-col gap-6">
      <PageHeader title={t("sharedData.title")} description={t("sharedData.description")} />
      <div className="flex flex-col gap-4">
        {grants.isPending ? (
          <LoadingState label={t("sharedData.loading")} />
        ) : grants.isError ? (
          <Callout
            tone="error"
            title={t("sharedData.failed")}
            icon={<CircleAlert className="size-5" />}
          >
            {errorMessage(t, grants.error)}
          </Callout>
        ) : items.length === 0 ? (
          <EmptyState title={t("sharedData.empty")}>{t("sharedData.emptyHint")}</EmptyState>
        ) : (
          <>
            <GrantTable items={items} />
            {grants.hasNextPage ? (
              <div>
                <Button
                  intent="secondary"
                  busy={grants.isFetchingNextPage}
                  onClick={() => void grants.fetchNextPage()}
                >
                  {t("sharedData.more")}
                </Button>
              </div>
            ) : null}
          </>
        )}
      </div>
    </div>
  );
}

function GrantTable({ items }: { items: DataGrantView[] }) {
  const t = useT();
  const date = useFormatDate();
  return (
    <Table caption={t("sharedData.listTitle")} stacked>
      <TableHead>
        <TableRow>
          <TableHeaderCell>{t("sharedData.artifact")}</TableHeaderCell>
          <TableHeaderCell>{t("sharedData.since")}</TableHeaderCell>
          <TableHeaderCell>{t("sharedData.status")}</TableHeaderCell>
          <TableHeaderCell>
            <span className="sr-only">{t("sharedData.actions")}</span>
          </TableHeaderCell>
        </TableRow>
      </TableHead>
      <TableBody>
        {items.map((item) => (
          <TableRow key={item.artifactId}>
            <TableCell>
              <div className="flex flex-col">
                <span>{item.artifactName ?? t("sharedData.gone")}</span>
                <span className="text-sm text-text-muted">{item.host}</span>
              </div>
            </TableCell>
            <TableCell>{date(item.firstGrantedAt)}</TableCell>
            <TableCell>
              {item.openGrants > 0 && item.expiresAt !== null
                ? t("sharedData.open", { date: date(item.expiresAt) })
                : t("sharedData.ended")}
            </TableCell>
            <TableCell>
              <div className="flex flex-wrap gap-2">
                <OwnData item={item} />
                <AskOwner item={item} />
                {item.openGrants > 0 ? <Revoke item={item} /> : null}
              </div>
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

/** Pages one download reads at most per click: far above what one day's allowance pays for. */
const MAX_PAGES = 200;
/**
 * Documents one delete batch reads: a small page costs little of the person's daily allowance,
 * so most of it goes to the deletes themselves.
 */
const DELETE_BATCH = 20;
/** Batches one delete reads at most per click. */
const MAX_DELETE_BATCHES = 100;

/** Where a paused download continues: the next page's cursor, the next part and what came so far. */
interface DownloadResume {
  after: string;
  part: number;
  saved: number;
}

const resumeKey = (artifactId: string) => `portifact.sharedData.download.${artifactId}`;

function readResume(artifactId: string): DownloadResume | null {
  try {
    const raw = JSON.parse(localStorage.getItem(resumeKey(artifactId)) ?? "null") as unknown;
    const value = raw as Partial<DownloadResume> | null;
    if (
      typeof value?.after === "string" &&
      Number.isInteger(value.part) &&
      Number.isInteger(value.saved)
    ) {
      return value as DownloadResume;
    }
  } catch {
    // Without storage a paused download continues only until the page reloads.
  }
  return null;
}

function writeResume(artifactId: string, resume: DownloadResume | null): void {
  try {
    if (resume === null) localStorage.removeItem(resumeKey(artifactId));
    else localStorage.setItem(resumeKey(artifactId), JSON.stringify(resume));
  } catch {
    // Kept in the page's state only.
  }
}

/** Whether a failure is the person's daily allowance being spent, which comes back tomorrow. */
const allowanceSpent = (error: unknown) =>
  error instanceof ApiFailure && error.code === "rate_limited";

type Pause = { reason: "allowance" | "error"; count: number } | null;

/**
 * What the person saved in the artifact: download it as JSON Lines (their own documents, as
 * stored, untrusted text) or delete it, whether or not a grant is still open. Both are charged to
 * the person's own daily allowance in the artifact, which a large dataset spends: a download then
 * saves what it got as a part and continues from its cursor on the next click (kept in this
 * browser), and deleting goes in small batches and continues from the first remaining document.
 */
function OwnData({ item }: { item: DataGrantView }) {
  const t = useT();
  const announce = useAnnounce();
  const { api, save } = useDashboard();
  const [confirming, setConfirming] = useState(false);
  const [resume, setResume] = useState<DownloadResume | null>(() => readResume(item.artifactId));
  const [downloadPause, setDownloadPause] = useState<Pause>(null);
  const [deletePause, setDeletePause] = useState<Pause>(null);
  const name = item.artifactName ?? item.host;
  const base = safeFileName(name);
  const keep = (next: DownloadResume | null) => {
    writeResume(item.artifactId, next);
    setResume(next);
  };
  const download = useMutation({
    mutationFn: async () => {
      const from = resume;
      const rows: { collection: string; id: string }[] = [];
      let after = from?.after ?? null;
      let failure: unknown = null;
      let finished = false;
      try {
        for (let page = 0; page < MAX_PAGES; page++) {
          const answer = await api.ownData(item.artifactId, after);
          rows.push(...answer.rows);
          after = answer.next;
          if (after === null) {
            finished = true;
            break;
          }
        }
      } catch (error) {
        failure = error;
      }
      // Nothing came and nothing is kept: an ordinary failure.
      if (!finished && rows.length === 0 && from === null)
        throw failure ?? new Error("nothing came back");
      return { from, rows, after, failure, finished };
    },
    onError: () => setDownloadPause(null),
    onSuccess: ({ from, rows, after, failure, finished }) => {
      const part = from?.part ?? 1;
      const saved = (from?.saved ?? 0) + rows.length;
      const fileName =
        finished && part === 1 ? `${base}-my-data.jsonl` : `${base}-my-data-part-${part}.jsonl`;
      if (rows.length > 0) {
        const text = rows.map((row) => JSON.stringify(row)).join("\n");
        save({ fileName, blob: new Blob([`${text}\n`], { type: "application/jsonl" }) });
      }
      if (finished) {
        keep(null);
        setDownloadPause(null);
        announce(
          saved === 0
            ? t("sharedData.nothingSaved", { name })
            : rows.length === 0
              ? t("sharedData.downloadedAll", { name, count: saved })
              : t("sharedData.downloaded", { file: fileName }),
        );
        return;
      }
      if (rows.length > 0 && after !== null) keep({ after, part: part + 1, saved });
      const pause: Pause = {
        reason: allowanceSpent(failure) ? "allowance" : "error",
        count: saved,
      };
      setDownloadPause(pause);
      announce(
        t(
          pause.reason === "allowance"
            ? "sharedData.downloadPausedAllowance"
            : "sharedData.downloadPausedError",
          {
            count: saved,
          },
        ),
      );
    },
  });
  const restart = () => {
    keep(null);
    setDownloadPause(null);
    download.reset();
  };
  const remove = useMutation({
    mutationFn: async () => {
      let count = 0;
      let failure: unknown = null;
      let done = false;
      try {
        for (let batch = 0; batch < MAX_DELETE_BATCHES; batch++) {
          // Always from the start: what was deleted is gone, so the first page is what is left.
          const page = await api.ownData(item.artifactId, null, DELETE_BATCH);
          if (page.rows.length === 0) {
            done = true;
            break;
          }
          for (const row of page.rows) {
            await api.deleteOwnDocument(item.artifactId, row.collection, row.id);
            count += 1;
          }
        }
      } catch (error) {
        failure = error;
      }
      // Nothing deleted and nothing paused: an ordinary failure, unless it is the allowance.
      if (!done && count === 0 && deletePause === null && !allowanceSpent(failure))
        throw failure ?? new Error("nothing came back");
      return { count, failure, done };
    },
    onError: () => setDeletePause(null),
    onSuccess: ({ count, failure, done }) => {
      const total = (deletePause?.count ?? 0) + count;
      if (done) {
        setConfirming(false);
        setDeletePause(null);
        announce(t("sharedData.deleted", { name, count: total }));
        return;
      }
      const pause: Pause = {
        reason: allowanceSpent(failure) ? "allowance" : "error",
        count: total,
      };
      setDeletePause(pause);
      announce(
        t(
          pause.reason === "allowance"
            ? "sharedData.deletePausedAllowance"
            : "sharedData.deletePausedError",
          {
            count: total,
          },
        ),
      );
    },
  });
  return (
    <>
      <Button
        intent="secondary"
        icon={<Download className="size-4" />}
        busy={download.isPending}
        onClick={() => download.mutate()}
        aria-label={t(resume ? "sharedData.downloadContinueNamed" : "sharedData.downloadNamed", {
          name,
        })}
      >
        {t(resume ? "sharedData.downloadContinue" : "sharedData.download")}
      </Button>
      {resume ? (
        <Button
          intent="secondary"
          icon={<RotateCcw className="size-4" />}
          disabled={download.isPending}
          onClick={restart}
          aria-label={t("sharedData.downloadRestartNamed", { name })}
        >
          {t("sharedData.downloadRestart")}
        </Button>
      ) : null}
      <Button
        intent="danger"
        icon={<Trash2 className="size-4" />}
        onClick={() => setConfirming(true)}
        aria-label={t("sharedData.deleteMineNamed", { name })}
      >
        {t("sharedData.deleteMine")}
      </Button>
      {downloadPause ? (
        <Callout
          tone="info"
          title={t("sharedData.downloadPaused")}
          icon={<CircleAlert className="size-5" />}
        >
          {t(
            downloadPause.reason === "allowance"
              ? "sharedData.downloadPausedAllowance"
              : "sharedData.downloadPausedError",
            { count: downloadPause.count },
          )}
        </Callout>
      ) : download.isError ? (
        <Callout
          tone="error"
          title={t("sharedData.downloadFailed")}
          icon={<CircleAlert className="size-5" />}
        >
          {errorMessage(t, download.error)}
        </Callout>
      ) : null}
      <ConfirmDialog
        open={confirming}
        title={t("sharedData.deleteTitle", { name })}
        confirmLabel={t(deletePause ? "sharedData.deleteContinue" : "sharedData.deleteMine")}
        cancelLabel={t("sharedData.cancel")}
        confirmIcon={<Trash2 className="size-4" />}
        tone="danger"
        busy={remove.isPending}
        onConfirm={() => remove.mutate()}
        onCancel={() => setConfirming(false)}
      >
        {t("sharedData.deleteBody")}
        {deletePause ? (
          <Callout
            tone="info"
            title={t("sharedData.deletePaused")}
            icon={<CircleAlert className="size-5" />}
          >
            {t(
              deletePause.reason === "allowance"
                ? "sharedData.deletePausedAllowance"
                : "sharedData.deletePausedError",
              { count: deletePause.count },
            )}
          </Callout>
        ) : remove.isError ? (
          <Callout
            tone="error"
            title={t("sharedData.deleteFailed")}
            icon={<CircleAlert className="size-5" />}
          >
            {errorMessage(t, remove.error)}
          </Callout>
        ) : null}
      </ConfirmDialog>
    </>
  );
}

/**
 * Asks the people who manage the artifact for a copy, or the erasure, of what the person saved
 * there. They get an email naming the person only by the ID the artifact's data holds.
 */
function AskOwner({ item }: { item: DataGrantView }) {
  const t = useT();
  const announce = useAnnounce();
  const { api } = useDashboard();
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState<"access" | "erasure">("access");
  const name = item.artifactName ?? item.host;
  const ask = useMutation({
    mutationFn: () => api.requestDataRights(item.artifactId, kind),
    onSuccess: () => {
      setOpen(false);
      announce(t("sharedData.askReceived", { name }));
    },
  });
  return (
    <>
      <Button
        intent="secondary"
        icon={<Mail className="size-4" />}
        onClick={() => setOpen(true)}
        aria-label={t("sharedData.askNamed", { name })}
      >
        {t("sharedData.ask")}
      </Button>
      <ConfirmDialog
        open={open}
        title={t("sharedData.askTitle", { name })}
        confirmLabel={t("sharedData.askSend")}
        cancelLabel={t("sharedData.cancel")}
        confirmIcon={<Mail className="size-4" />}
        busy={ask.isPending}
        onConfirm={() => ask.mutate()}
        onCancel={() => setOpen(false)}
      >
        <div className="flex flex-col gap-3">
          <p>{t("sharedData.askBody")}</p>
          <RadioGroup<"access" | "erasure">
            legend={t("sharedData.askKind")}
            name={`ask-${item.artifactId}`}
            value={kind}
            onChange={setKind}
            options={[
              { value: "access", label: t("sharedData.askAccess") },
              { value: "erasure", label: t("sharedData.askErasure") },
            ]}
          />
          {ask.isError ? (
            <Callout
              tone="error"
              title={t("sharedData.askFailed")}
              icon={<CircleAlert className="size-5" />}
            >
              {errorMessage(t, ask.error)}
            </Callout>
          ) : null}
        </div>
      </ConfirmDialog>
    </>
  );
}

function Revoke({ item }: { item: DataGrantView }) {
  const t = useT();
  const announce = useAnnounce();
  const { api } = useDashboard();
  const queryClient = useQueryClient();
  const [confirming, setConfirming] = useState(false);
  const name = item.artifactName ?? item.host;
  const revoke = useMutation({
    mutationFn: () => api.revokeDataGrants(item.artifactId),
    onSuccess: () => {
      setConfirming(false);
      announce(t("sharedData.revoked", { name }));
      void queryClient.invalidateQueries({ queryKey: DATA_GRANTS_QUERY });
    },
  });
  return (
    <>
      <Button
        intent="danger"
        icon={<Unplug className="size-4" />}
        onClick={() => setConfirming(true)}
        aria-label={t("sharedData.revokeNamed", { name })}
      >
        {t("sharedData.revoke")}
      </Button>
      <ConfirmDialog
        open={confirming}
        title={t("sharedData.confirmTitle", { name })}
        confirmLabel={t("sharedData.revoke")}
        cancelLabel={t("sharedData.cancel")}
        confirmIcon={<Unplug className="size-4" />}
        tone="danger"
        busy={revoke.isPending}
        onConfirm={() => revoke.mutate()}
        onCancel={() => setConfirming(false)}
      >
        {t("sharedData.confirmBody")}
        {revoke.isError ? (
          <Callout
            tone="error"
            title={t("sharedData.revokeFailed")}
            icon={<CircleAlert className="size-5" />}
          >
            {errorMessage(t, revoke.error)}
          </Callout>
        ) : null}
      </ConfirmDialog>
    </>
  );
}
