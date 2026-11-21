import { cn } from "../../lib/utils";

/**
 * The spinner, used by every button that waits on the server.
 *
 * Not from shadcn — it has none — but it belongs with these files: one spinner for the whole app, sized by `className`,
 * with the `spinner` test id the cases look for.
 */
export function Spinner({ className }: { className?: string }) {
  return (
    <svg data-testid="spinner" viewBox="0 0 24 24" className={cn("h-4 w-4 animate-spin", className)} fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" aria-hidden="true">
      <path d="M12 3a9 9 0 1 0 9 9" />
    </svg>
  );
}
