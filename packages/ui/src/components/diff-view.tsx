// A line diff of one text file (premium plan P3): a data table, unified (one row per line) or
// side by side (earlier and later versions in two columns). Added and removed lines never rely
// on color: each carries a visible + or - sign, a different background pattern and visually
// hidden text that names the change, and line numbers sit in their own columns.
import { Table } from "./table.tsx";

export interface DiffViewLine {
  type: "context" | "added" | "removed";
  text: string;
  before: number | null;
  after: number | null;
  noNewline: boolean;
}

export interface DiffViewHunk {
  beforeStart: number;
  beforeLines: number;
  afterStart: number;
  afterLines: number;
  lines: DiffViewLine[];
}

export interface DiffViewLabels {
  /** Column headers. */
  before: string;
  after: string;
  change: string;
  text: string;
  /** What assistive technology hears for each kind of line. */
  added: string;
  removed: string;
  unchanged: string;
  noNewline: string;
  /** The row that starts a hunk. */
  hunk: (hunk: DiffViewHunk) => string;
}

export interface DiffViewProps {
  caption: string;
  hunks: DiffViewHunk[];
  layout: "unified" | "split";
  labels: DiffViewLabels;
}

const SIGN = { context: " ", added: "+", removed: "-" } as const;
const ROW = {
  context: "",
  added: "bg-selection",
  removed: "bg-hatch",
} as const;
const number = "w-px px-2 py-0.5 text-right align-top text-text-muted tabular-nums select-none";
const code = "px-2 py-0.5 align-top font-mono whitespace-pre-wrap break-all";

function LineText({ line, labels }: { line: DiffViewLine; labels: DiffViewLabels }) {
  const name =
    line.type === "added" ? labels.added : line.type === "removed" ? labels.removed : null;
  return (
    <>
      {name ? <span className="sr-only">{`${name}: `}</span> : null}
      {line.text}
      {line.noNewline ? (
        <span className="ml-2 font-sans text-text-muted">{`(${labels.noNewline})`}</span>
      ) : null}
    </>
  );
}

function Sign({ line, labels }: { line: DiffViewLine; labels: DiffViewLabels }) {
  const name =
    line.type === "added"
      ? labels.added
      : line.type === "removed"
        ? labels.removed
        : labels.unchanged;
  return (
    <td className="w-px px-2 py-0.5 text-center align-top font-mono font-semibold">
      <span aria-hidden="true">{SIGN[line.type]}</span>
      <span className="sr-only">{name}</span>
    </td>
  );
}

/** Pairs each run of removed lines with the added lines after it, for the split layout. */
function splitRows(lines: DiffViewLine[]): [DiffViewLine | null, DiffViewLine | null][] {
  const rows: [DiffViewLine | null, DiffViewLine | null][] = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index] as DiffViewLine;
    if (line.type === "context") {
      rows.push([line, line]);
      index++;
      continue;
    }
    const removed: DiffViewLine[] = [];
    const added: DiffViewLine[] = [];
    while (index < lines.length && (lines[index] as DiffViewLine).type === "removed") {
      removed.push(lines[index] as DiffViewLine);
      index++;
    }
    while (index < lines.length && (lines[index] as DiffViewLine).type === "added") {
      added.push(lines[index] as DiffViewLine);
      index++;
    }
    for (let k = 0; k < Math.max(removed.length, added.length); k++) {
      rows.push([removed[k] ?? null, added[k] ?? null]);
    }
  }
  return rows;
}

function SplitSide({
  line,
  side,
  labels,
}: {
  line: DiffViewLine | null;
  side: "before" | "after";
  labels: DiffViewLabels;
}) {
  if (line === null) {
    return (
      <>
        <td className={`${number} bg-surface`} />
        <td className={`${code} bg-surface`} />
      </>
    );
  }
  const tone = line.type === "context" ? "" : ROW[line.type];
  return (
    <>
      <td className={`${number} ${tone}`}>{line[side]}</td>
      <td className={`${code} ${tone}`}>
        {line.type === "context" ? null : (
          <span aria-hidden="true" className="mr-1 font-semibold">
            {SIGN[line.type]}
          </span>
        )}
        <LineText line={line} labels={labels} />
      </td>
    </>
  );
}

/**
 * The hunks of a diff as a `Table`, in its own focusable scrolling region, so long lines never
 * widen the page. Each hunk starts with a header row naming where it is.
 */
export function DiffView({ caption, hunks, layout, labels }: DiffViewProps) {
  return (
    <Table caption={caption}>
      <thead className="border-b border-border bg-surface">
        {layout === "unified" ? (
          <tr>
            <th scope="col" className="px-2 py-2 font-semibold">
              {labels.before}
            </th>
            <th scope="col" className="px-2 py-2 font-semibold">
              {labels.after}
            </th>
            <th scope="col" className="px-2 py-2 font-semibold">
              {labels.change}
            </th>
            <th scope="col" className="px-2 py-2 font-semibold">
              {labels.text}
            </th>
          </tr>
        ) : (
          <tr>
            <th scope="colgroup" colSpan={2} className="px-2 py-2 font-semibold">
              {labels.before}
            </th>
            <th scope="colgroup" colSpan={2} className="px-2 py-2 font-semibold">
              {labels.after}
            </th>
          </tr>
        )}
      </thead>
      {hunks.map((hunk) => (
        <tbody
          key={`${hunk.beforeStart}-${hunk.afterStart}`}
          className="border-b border-border last:border-b-0"
        >
          <tr className="bg-surface">
            <th
              scope="rowgroup"
              colSpan={4}
              className="px-2 py-1 text-left font-mono font-normal text-text-muted"
            >
              {labels.hunk(hunk)}
            </th>
          </tr>
          {layout === "unified"
            ? hunk.lines.map((line, index) => (
                <tr key={`${line.before}-${line.after}-${index}`} className={ROW[line.type]}>
                  <td className={number}>{line.before}</td>
                  <td className={number}>{line.after}</td>
                  <Sign line={line} labels={labels} />
                  <td className={code}>
                    <LineText line={line} labels={labels} />
                  </td>
                </tr>
              ))
            : splitRows(hunk.lines).map(([before, after], index) => (
                <tr key={`${before?.before}-${after?.after}-${index}`}>
                  <SplitSide line={before} side="before" labels={labels} />
                  <SplitSide line={after} side="after" labels={labels} />
                </tr>
              ))}
        </tbody>
      ))}
    </Table>
  );
}
