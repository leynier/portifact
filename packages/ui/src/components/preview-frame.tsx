export interface PreviewFrameProps {
  /** Accessible name of the frame, such as "Preview of Plan". */
  title: string;
  /** A complete, untrusted HTML document. */
  html: string;
}

/**
 * Shows an untrusted rendered document inside the page. The frame gets an empty `sandbox`, so
 * the document runs in an opaque origin with no scripts, forms, popups or navigation of the
 * page, and `srcdoc`, so nothing is fetched to show it. It also inherits the page's policy.
 * It never receives tokens or other credentials.
 */
export function PreviewFrame({ title, html }: PreviewFrameProps) {
  return (
    <iframe
      title={title}
      sandbox=""
      srcDoc={html}
      referrerPolicy="no-referrer"
      className="h-128 w-full rounded-lg border border-border bg-canvas"
    />
  );
}
