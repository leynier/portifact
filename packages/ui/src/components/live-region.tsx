export interface LiveRegionProps {
  /** The latest message. Changing it announces the new text politely. */
  message: string;
}

/** An invisible polite live region for results of actions, such as "Artifact archived". */
export function LiveRegion({ message }: LiveRegionProps) {
  return (
    <p role="status" aria-live="polite" className="sr-only">
      {message}
    </p>
  );
}
