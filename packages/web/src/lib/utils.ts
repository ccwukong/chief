import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/**
 * Join class names, last one winning where two Tailwind classes do the same job.
 *
 * `cn("p-2", condition && "p-4")` is `p-4`, not both — which is the bug template-literal concatenation invites:
 * `${base} ${extra}` puts a later `p-4` in the class list beside `p-2` and leaves the winner to stylesheet order.
 *
 * This is the `cn` shadcn/ui uses, in the place it expects (`lib/utils`), so a component taken from shadcn keeps
 * working as written. chief's own components use it too — there is one way to compose classes here, not two.
 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
