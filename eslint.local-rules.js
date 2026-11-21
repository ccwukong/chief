/**
 * Rules that encode a correction so it cannot come back.
 *
 * They live here, in the repository, rather than in a review checklist: a comment asking the next
 * person to be careful is not enforceable, and an agent with a narrow prompt and a few nearby files
 * will not read it. A rule fails the build instead. Each one exists because something went wrong.
 *
 * `no-raw-timers` — three polling loops and two zero-delay `setTimeout` calls (one to scroll a row
 *   after rendering, one to focus a field) had grown in the web UI. The zero-delay ones raced the
 *   DOM and only worked on a fast machine; the polling loops were three copies of the same idea.
 *   `packages/web/src/polling.ts` now owns both behaviours, and this rule points at it.
 *
 * `task-id-in-todos` — a directive comment promising later work is a promise nobody keeps. It must
 *   name the task that will handle it (a dev-plan id like `14.1`, or a case id like `E14.1-1`), so
 *   it shows up in the plan instead of ageing in the file.
 */

/** The directive form only (a marker followed by a colon or a parenthesis): the bare word is prose. */
const TODO = /\b(TODO|FIXME|HACK|XXX)\b\s*[:(]/i;
const TASK_ID = /\b\d+\.\d+a?\b|\bE\d+\.\d+a?-\d+\b/;

/** The second argument of `setTimeout`: absent or the literal 0 means "run it later, and hope". */
const isZeroDelay = (node) => {
  const second = node.arguments?.[1];
  if (!second) return true; // setTimeout(fn) === setTimeout(fn, 0)
  return (second.type === "Literal" && second.value === 0) || (second.type === "TemplateLiteral" && second.quasis.length === 1 && second.quasis[0].value.raw === "0");
};

export const rules = {
  "no-raw-timers": {
    meta: {
      type: "problem",
      docs: { description: "Timers belong in src/polling.ts, so a page cannot paper over a missing signal" },
      schema: [],
      messages: {
        interval: "Do not start an interval here: use `usePolling(run, everyMs, deps)` from `src/polling.ts` (it stops on unmount and always calls the latest closure).",
        frame: "Do not use `requestAnimationFrame` in a page: the behaviour you want is a render, an effect, or `useReveal` from `src/polling.ts`.",
        zero: "A zero-delay `setTimeout` races the DOM. Use an effect for \"after render\", or `useReveal` from `src/polling.ts` for \"scroll to it after it exists\". A timeout with a real delay (debouncing typing) is fine.",
      },
    },
    create(context) {
      return {
        CallExpression(node) {
          const name = node.callee?.type === "Identifier" ? node.callee.name : null;
          if (name === "setInterval") context.report({ node, messageId: "interval" });
          else if (name === "requestAnimationFrame") context.report({ node, messageId: "frame" });
          else if (name === "setTimeout" && isZeroDelay(node)) context.report({ node, messageId: "zero" });
        },
      };
    },
  },

  "task-id-in-todos": {
    meta: {
      type: "problem",
      docs: { description: "A TODO/FIXME/HACK comment must name the task that will handle it" },
      schema: [],
      messages: {
        missing: "This comment promises later work but names no task. Add the dev-plan id (for example `(task 14.1)`), or do the work now: a TODO nobody can find is not tracked.",
      },
    },
    create(context) {
      return {
        Program() {
          for (const comment of context.sourceCode.getAllComments()) {
            if (!TODO.test(comment.value)) continue;
            if (TASK_ID.test(comment.value)) continue;
            context.report({ loc: comment.loc, messageId: "missing" });
          }
        },
      };
    },
  },
};

export const plugin = { meta: { name: "chief-local" }, rules };
