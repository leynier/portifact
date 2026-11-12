// The canonical accepted envelope of decision 0027 ("The envelope"). One bounded value per
// operation is the single source of what the owner is shown and what the agent receives: the
// confirmation's lines are rendered from it, and the change item exports it unchanged. Every
// string in it is shown in the lines through the typed display, so nothing reaches the agent that
// the owner did not see. Context is the stored file around the exact range, at most 120 UTF-16
// units on each side, with explicit omission counts.
import {
  DELETED_ACCOUNT,
  type Destination,
  type EditOperation,
  type ElementAnchor,
  type Envelope,
  type EnvelopeContext,
  type EnvelopeLocation,
  type EnvelopeOperation,
  PLAN_LIMITS,
  type ShownEnvelope,
  type TextAnchor,
} from "@portifact/contracts";
import { utf8Length } from "./digest.ts";
import { omitted, visible } from "./display.ts";

export function locationOf(source: string, start: number, end: number): EnvelopeLocation {
  const lineStart = source.lastIndexOf("\n", start - 1) + 1;
  let line = 1;
  for (let at = source.indexOf("\n"); at >= 0 && at < start; at = source.indexOf("\n", at + 1)) {
    line++;
  }
  return { unit: "utf16", start, end, line, column: start - lineStart + 1 };
}

export function contextOf(source: string, start: number, end: number): EnvelopeContext {
  const units = PLAN_LIMITS.contextUnits;
  const from = Math.max(0, start - units);
  const to = Math.min(source.length, end + units);
  return {
    before: source.slice(from, start),
    after: source.slice(end, to),
    omittedBefore: from,
    omittedAfter: source.length - to,
  };
}

// The schemas guarantee the anchors' kinds: a text operation targets text, the others elements.
const describe = (target: EditOperation["target"]) => {
  const anchor = target.anchor as ElementAnchor;
  return { tag: anchor.tagName, label: anchor.fingerprint };
};

/** The envelope's description of an operation: what the person changed, as plain values. */
export function envelopeOperation(operation: EditOperation): EnvelopeOperation {
  if (operation.kind === "text") {
    const anchor = operation.target.anchor as TextAnchor;
    return { kind: "text", before: anchor.quote.exact, after: operation.after };
  }
  if (operation.kind === "style") {
    return {
      kind: "style",
      element: describe(operation.target),
      changes: operation.changes.map(({ property, before, after }) => ({
        property,
        before,
        after,
      })),
    };
  }
  return {
    kind: "structure",
    action: operation.action,
    element: describe(operation.target),
    destination:
      operation.action === "move"
        ? { element: describe(operation.destination.target), place: operation.destination.place }
        : null,
  };
}

function operationLines(operation: EnvelopeOperation): string[] {
  if (operation.kind === "text") {
    return [`before: ${visible(operation.before)}`, `after: ${visible(operation.after)}`];
  }
  const element = (described: { tag: string; label: string }) =>
    `${visible(described.tag)} "${visible(described.label)}"`;
  if (operation.kind === "style") {
    return [
      `element: ${element(operation.element)}`,
      ...operation.changes.map(
        (change) =>
          `style: ${visible(change.property)} from ${change.before === null ? "unknown" : visible(change.before)} to ${visible(change.after)}`,
      ),
    ];
  }
  return [
    `element: ${element(operation.element)}`,
    operation.destination
      ? `${operation.action}: ${operation.destination.place} ${element(operation.destination.element)}`
      : `${operation.action}`,
  ];
}

/** A destination's line: where it goes, next to how it is written and where to read it whole. */
function linkLine(link: Destination): string {
  const where = link.resolved
    ? `${visible(link.effective)}${omitted(link.effectiveOmitted)}`
    : "⟦could not be resolved⟧";
  const at = link.at ? `, at ${link.at.file} ${link.at.start} to ${link.at.end}` : "";
  return `link to: ${where} (written as ${visible(link.authored)}${omitted(link.authoredOmitted)}${at})`;
}

const personOf = (known: boolean) => (known ? "an account" : DELETED_ACCOUNT);

/**
 * The lines a person sees for one envelope; the agent's copy is the envelope itself. Every
 * string of the envelope appears here, through the typed display. A canonical envelope names
 * its people only as known or deleted; a shown one (`presentEnvelope`) by their current names.
 */
export function renderEnvelope(envelope: Envelope | ShownEnvelope): string[] {
  const location = envelope.location;
  const where =
    "unresolved" in location
      ? "location: unresolved (the selected text could not be mapped to the file)"
      : `location: ${location.unit} ${location.start} to ${location.end}, line ${location.line}, column ${location.column}`;
  const lines = [
    envelope.status === "applied"
      ? `status: applied, ${envelope.operation.kind} change`
      : `status: listed (${envelope.reason ?? "unknown"}), ${envelope.operation.kind} change`,
    where,
    ...operationLines(envelope.operation),
  ];
  const context = envelope.context;
  if (context) {
    lines.push(
      `source: ${omitted(context.omittedBefore)}${visible(context.before)}⟦change here⟧${visible(context.after)}${omitted(context.omittedAfter)}`,
    );
  }
  if (!envelope.destinationsKnown) {
    lines.push("links: not known (the selection could not be placed on the page)");
  }
  for (const link of envelope.destinations) lines.push(linkLine(link));
  const { binding, people } = envelope;
  const names =
    "provenance" in envelope
      ? envelope.provenance
      : { submittedBy: personOf(people.submitter), acceptedBy: personOf(people.acceptor) };
  const route = binding.route === null ? "no route" : `route ${visible(binding.route)}`;
  lines.push(
    `file: ${visible(binding.path)} (${route}) of artifact ${visible(binding.artifactId)}, version ${visible(binding.versionId)}, sha256 ${binding.fileSha256}, renderer ${visible(binding.renderer)}`,
    `suggestion: ${visible(binding.subject)} revision ${binding.revision}, suggested by ${visible(names.submittedBy)}, accepted by ${visible(names.acceptedBy)}`,
  );
  return lines;
}

/**
 * An envelope as it is shown or exported: the canonical one with its people's current display
 * names, or `DELETED_ACCOUNT` for a person whose account reference was erased (null) or who was
 * already gone when the plan was built.
 */
export function presentEnvelope(
  envelope: Envelope,
  names: { submittedBy: string | null; acceptedBy: string | null },
): ShownEnvelope {
  const name = (known: boolean, value: string | null) =>
    known && value !== null ? value : DELETED_ACCOUNT;
  return {
    ...envelope,
    provenance: {
      submittedBy: name(envelope.people.submitter, names.submittedBy),
      acceptedBy: name(envelope.people.acceptor, names.acceptedBy),
    },
  };
}

export const envelopeBytes = (envelope: Envelope): number => utf8Length(JSON.stringify(envelope));
export { DELETED_ACCOUNT } from "@portifact/contracts";
