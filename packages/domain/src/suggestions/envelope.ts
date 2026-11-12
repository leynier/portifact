// The canonical accepted envelope of decision 0027 ("The envelope"). One bounded value per
// operation is the single source of what the owner is shown and what the agent receives: the
// confirmation's lines are rendered from it, and the change item exports it unchanged. Every
// string in it is shown in the lines through the typed display, so nothing reaches the agent that
// the owner did not see. Context is the stored file around the exact range, at most 120 UTF-16
// units on each side, with explicit omission counts.
import {
  type EditOperation,
  type ElementAnchor,
  type Envelope,
  type EnvelopeContext,
  type EnvelopeLocation,
  type EnvelopeOperation,
  PLAN_LIMITS,
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

/**
 * The lines the owner sees for one envelope; the agent's copy is the envelope itself. Every
 * string of the envelope appears here, through the typed display.
 */
export function renderEnvelope(envelope: Envelope): string[] {
  const location = envelope.location;
  const where =
    "unresolved" in location
      ? "location: unresolved (not found once in the file)"
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
  for (const link of envelope.destinations) {
    lines.push(
      `link to: ${visible(link.effective)}${omitted(link.effectiveOmitted)} (written as ${visible(link.authored)}${omitted(link.authoredOmitted)})`,
    );
  }
  const { binding, provenance } = envelope;
  lines.push(
    `file: ${visible(binding.path)} of artifact ${visible(binding.artifactId)}, version ${visible(binding.versionId)}, sha256 ${binding.fileSha256}, renderer ${visible(binding.renderer)}`,
    `suggestion: ${visible(binding.subject)} revision ${binding.revision}, suggested by ${visible(provenance.submittedBy)}, accepted by ${visible(provenance.acceptedBy)}`,
  );
  return lines;
}

export const envelopeBytes = (envelope: Envelope): number => utf8Length(JSON.stringify(envelope));
