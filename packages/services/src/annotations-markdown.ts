// Markdown export of annotations, written to hand review feedback to an agent (plan section 8).
// Everything that comes from reviewers (bodies, quotes, names, selectors) is untrusted: bodies
// and quotes go in fenced blocks longer than any backtick run they hold, so they cannot close
// the fence or become headings, links or instructions in the surrounding document, and short
// fields go in code spans or are escaped.
import type {
  AnnotationExport,
  AnnotationMessageView,
  AnnotationThreadView,
} from "@portifact/contracts";

/** A fenced block that the content cannot end early. */
export function fenced(content: string): string {
  const longest = Math.max(0, ...[...content.matchAll(/`+/g)].map((match) => match[0].length));
  const fence = "`".repeat(Math.max(3, longest + 1));
  return `${fence}text\n${content}\n${fence}`;
}

/** An inline code span that the content cannot end early. */
export function codeSpan(content: string): string {
  const single = content.replace(/[\r\n]+/g, " ");
  const longest = Math.max(0, ...[...single.matchAll(/`+/g)].map((match) => match[0].length));
  const ticks = "`".repeat(longest + 1);
  const pad = single.startsWith("`") || single.endsWith("`") ? " " : "";
  return `${ticks}${pad}${single}${pad}${ticks}`;
}

/** Plain text in a Markdown line: one line, with Markdown and HTML punctuation escaped. */
export function escapeInline(content: string): string {
  return content.replace(/[\r\n]+/g, " ").replace(/[\\`*_{}[\]()#+\-.!|<>~&]/g, "\\$&");
}

function authorName(message: { author: AnnotationMessageView["author"] }): string {
  return message.author
    ? escapeInline(message.author.name || "Unnamed reviewer")
    : "Deleted account";
}

function describeTarget(thread: AnnotationThreadView): string[] {
  const lines = [`- File: ${codeSpan(thread.path)}`];
  if (thread.target.route) lines.push(`- Route: ${codeSpan(thread.target.route)}`);
  const anchor = thread.target.anchor;
  if (anchor.kind === "document") {
    lines.push("- Target: the whole document");
  } else if (anchor.kind === "element") {
    lines.push(
      `- Target: element ${codeSpan(anchor.tagName)} at ${codeSpan(anchor.selectors[0] ?? "")}`,
    );
    if (anchor.fingerprint) lines.push("- Element text:", "", fenced(anchor.fingerprint), "");
  } else {
    lines.push(
      `- Target: text at ${anchor.position.start}-${anchor.position.end}`,
      "- Quote:",
      "",
      fenced(anchor.quote.exact),
      "",
    );
  }
  return lines;
}

function messageLines(message: AnnotationMessageView, index: number): string[] {
  const edited = message.editedAt ? `, edited ${message.editedAt}` : "";
  const heading = `${index + 1}. ${authorName(message)} (${message.createdAt}${edited})`;
  if (message.state === "deleted") return [`${heading}: message deleted`, ""];
  if (message.body === null) return [`${heading}: hidden by the owner`, ""];
  const hidden = message.state === "hidden" ? " (hidden by the owner)" : "";
  return [`${heading}${hidden}:`, "", fenced(message.body), ""];
}

/** The export as Markdown: the untrusted-data notice first, then one section per thread. */
export function annotationsToMarkdown(data: AnnotationExport): string {
  const a = data.artifact;
  const lines = [
    `# Annotations on ${escapeInline(a.name)}`,
    "",
    `> ${data.notice}`,
    "",
    `- Artifact: ${codeSpan(a.id)} (${a.type})`,
    `- Annotations: ${a.annotations}`,
    `- Current version: ${a.currentVersionId ? codeSpan(a.currentVersionId) : "none"}`,
    `- Exported: ${data.exportedAt}`,
    `- Threads: ${data.threads.length}`,
    "",
  ];
  data.threads.forEach((thread, index) => {
    const version = thread.current ? "current version" : "previous version";
    lines.push(
      `## Thread ${index + 1} (${thread.state}, ${version})`,
      "",
      `- Thread ID: ${codeSpan(thread.id)}`,
      `- Version: ${codeSpan(thread.versionId)}`,
      `- Started by: ${authorName(thread)} on ${thread.createdAt}`,
      ...describeTarget(thread),
      "",
      "### Messages",
      "",
      ...thread.messages.flatMap(messageLines),
    );
  });
  return `${lines
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trimEnd()}\n`;
}
