import { LoaderCircle } from "lucide-react";

export interface LoadingStateProps {
  /** What is loading, in words. A spinner alone is never enough. */
  label: string;
  /**
   * Placeholder rows drawn under the label in the shape of what is coming, such as table rows.
   * They are decorative and hidden from assistive technology; the label is what is read.
   */
  skeleton?: number;
  /**
   * `inline` (the default) sits in the flow; `centered` fills its container and centers a larger
   * spinner over the label, for a whole area such as the viewer's frame; `cover` does the same over
   * the content of its nearest positioned ancestor, hiding it until the loading ends.
   */
  layout?: "inline" | "centered" | "cover";
}

/** A visible, announced loading message. Nothing moves unless motion is allowed. */
export function LoadingState({ label, skeleton = 0, layout = "inline" }: LoadingStateProps) {
  if (layout !== "inline") {
    return (
      <div
        className={`flex flex-1 flex-col items-center justify-center gap-3 bg-canvas p-8 text-center motion-safe:animate-fade ${
          layout === "cover" ? "absolute inset-0 z-10" : "min-h-full"
        }`}
      >
        <span
          aria-hidden="true"
          className="flex size-12 items-center justify-center rounded-full border border-border bg-surface shadow-sm"
        >
          <LoaderCircle className="size-6 text-text motion-safe:animate-spin" />
        </span>
        <p role="status" className="text-sm font-medium text-text-muted">
          {label}
        </p>
      </div>
    );
  }
  return (
    <div className="py-4">
      <p role="status" className="flex items-center gap-2 text-sm text-text-muted">
        <LoaderCircle aria-hidden="true" className="size-4 motion-safe:animate-spin" />
        {label}
      </p>
      {skeleton > 0 ? (
        <div
          aria-hidden="true"
          className="mt-4 divide-y divide-border overflow-hidden rounded-lg border border-border bg-canvas"
        >
          {Array.from({ length: skeleton }, (_, index) => (
            // Placeholders never reorder.
            <div key={index} className="flex items-center gap-4 px-4 py-4">
              <span className="h-3 w-2/5 rounded-xs bg-surface-hover motion-safe:animate-shimmer" />
              <span className="h-3 w-1/6 rounded-xs bg-surface-hover motion-safe:animate-shimmer" />
              <span className="ml-auto h-3 w-1/5 rounded-xs bg-surface-hover motion-safe:animate-shimmer" />
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
