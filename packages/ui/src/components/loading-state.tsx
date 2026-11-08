import { LoaderCircle } from "lucide-react";

export interface LoadingStateProps {
  /** What is loading, in words. A spinner alone is never enough. */
  label: string;
}

/** A visible, announced loading message. The spinner only moves when motion is allowed. */
export function LoadingState({ label }: LoadingStateProps) {
  return (
    <p role="status" className="flex items-center gap-2 py-8 text-sm text-text-muted">
      <LoaderCircle aria-hidden="true" className="size-4 motion-safe:animate-spin" />
      {label}
    </p>
  );
}
