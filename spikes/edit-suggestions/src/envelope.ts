// The canonical accepted envelope of decision 0027 (rule 4 of the second round). One bounded value
// per operation is the single source of what the owner is shown and what the agent receives: the
// confirmation's lines are rendered from it, and the change-list item exports it unchanged. Every
// string in it is shown in the lines (through the typed display), so nothing reaches the agent
// that the owner did not see. Context is the stored file around the exact range, at most 120
// UTF-16 units on each side, with explicit omission counts. The size limit is checked before the
// plan is hashed.
import { type Destination, omitted, visible } from "./display.ts";
import type { UncertainReason } from "./edit.ts";

export const ENVELOPE_LIMITS = {
  contextUnits: 120,
  envelopeBytes: 16 * 1024,
  planBytes: 512 * 1024,
} as const;

export interface Binding {
  artifactId: string;
  versionId: string;
  path: string;
  /** SHA-256 of the stored file the plan was built from. */
  fileSha256: string;
  /** Renderer of the stored rendering; the plan verifies that it reproduces it. */
  renderer: string;
  suggestionId: string;
  suggestionRevision: number;
}

export interface Provenance {
  submittedBy: string;
  acceptedBy: string;
}

export interface Envelope {
  format: 1;
  status: "applied" | "listed";
  reason: UncertainReason | null;
  operation: { kind: "text"; before: string; after: string };
  binding: Binding;
  provenance: Provenance;
  /** Where the change is in the stored file, in UTF-16 units, with its 1-based line and column. */
  location:
    | { unit: "utf16"; start: number; end: number; line: number; column: number }
    | { unresolved: true };
  context: { before: string; after: string; omittedBefore: number; omittedAfter: number } | null;
  destinations: Destination[];
}

export function locationOf(source: string, start: number, end: number): Envelope["location"] {
  const lineStart = source.lastIndexOf("\n", start - 1) + 1;
  return {
    unit: "utf16",
    start,
    end,
    line: source.slice(0, start).split("\n").length,
    column: start - lineStart + 1,
  };
}

export function contextOf(
  source: string,
  start: number,
  end: number,
): NonNullable<Envelope["context"]> {
  const units = ENVELOPE_LIMITS.contextUnits;
  const from = Math.max(0, start - units);
  const to = Math.min(source.length, end + units);
  return {
    before: source.slice(from, start),
    after: source.slice(end, to),
    omittedBefore: from,
    omittedAfter: source.length - to,
  };
}

/**
 * The lines the owner sees for one envelope; the agent's copy is the envelope itself. Every string
 * of the envelope appears here, through the typed display.
 */
export function renderEnvelope(envelope: Envelope): string[] {
  const where =
    "unresolved" in envelope.location
      ? "location: unresolved (not found once in the file)"
      : `location: ${envelope.location.unit} ${envelope.location.start} to ${envelope.location.end}, line ${envelope.location.line}, column ${envelope.location.column}`;
  const lines = [
    envelope.status === "applied"
      ? `status: applied, ${envelope.operation.kind} change`
      : `status: listed (${envelope.reason}), ${envelope.operation.kind} change`,
    where,
    `before: ${visible(envelope.operation.before)}`,
    `after: ${visible(envelope.operation.after)}`,
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
    `file: ${visible(binding.path)} of artifact ${binding.artifactId}, version ${binding.versionId}, sha256 ${binding.fileSha256}, renderer ${binding.renderer}`,
    `suggestion: ${binding.suggestionId} revision ${binding.suggestionRevision}, suggested by ${provenance.submittedBy}, accepted by ${provenance.acceptedBy}`,
  );
  return lines;
}

export function envelopeBytes(envelope: Envelope): number {
  return new TextEncoder().encode(JSON.stringify(envelope)).length;
}
