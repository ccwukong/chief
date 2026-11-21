import * as React from "react";
import { cn } from "../../lib/utils";

/** shadcn/ui's input. The type scale is chief's (`text-sm` at every size the app allows), not a fixed 14 px. */
const Input = React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(({ className, type, ...props }, ref) => (
  <input
    type={type}
    ref={ref}
    className={cn(
      "flex h-9 w-full rounded-md border border-input bg-background px-2.5 py-1 text-sm text-foreground shadow-xs transition-colors",
      "placeholder:text-muted-foreground selection:bg-primary selection:text-primary-foreground",
      "focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring",
      "aria-invalid:border-destructive aria-invalid:ring-[3px] aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40",
      "disabled:cursor-not-allowed disabled:opacity-60",
      className,
    )}
    {...props}
  />
));
Input.displayName = "Input";

export { Input };
