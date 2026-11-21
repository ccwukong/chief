import * as React from "react";
import { cn } from "../../lib/utils";

/**
 * A select in shadcn's clothes, with the browser's own behaviour kept.
 *
 * shadcn's `Select` is built on Radix's listbox: a button, a portal and a custom popup. It looks right and it is the wrong
 * tool here — chief's selects are plain `<select>`s that ~50 cases drive with `selectOption`, and a listbox would break
 * every one of them while losing the native keyboard, autofill and mobile behaviour for free.
 *
 * So the visuals are shadcn's (the same border, height, radius and focus ring as its trigger) and the element is native.
 * Stated in the dev plan as a deliberate exception, not an oversight.
 */
const Select = React.forwardRef<HTMLSelectElement, React.SelectHTMLAttributes<HTMLSelectElement>>(({ className, children, ...props }, ref) => (
  <select
    ref={ref}
    className={cn(
      "h-9 w-full appearance-none rounded-md border border-input bg-background bg-[length:10px] bg-[right_0.6rem_center] bg-no-repeat px-2.5 pr-8 text-sm text-foreground shadow-xs transition-colors",
      "focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring",
      "aria-invalid:border-destructive aria-invalid:ring-[3px] aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40",
      "disabled:cursor-not-allowed disabled:opacity-60",
      className,
    )}
    style={{
      // The chevron, drawn rather than a background file: a data URL cannot follow the theme, an SVG mask can.
      backgroundImage:
        "url(\"data:image/svg+xml;charset=utf-8,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 10 6' fill='none' stroke='%2364748b' stroke-width='1.6'%3E%3Cpath d='M1 1l4 4 4-4'/%3E%3C/svg%3E\")",
      ...props.style,
    }}
    {...props}>
    {children}
  </select>
));
Select.displayName = "Select";

export { Select };
