# chief Design System

The UI/UX standard for every human and coding agent working in `packages/web/src/`. Rules marked
**(enforced)** are checked automatically by `npm run check` (`scripts/guardrails.mjs` and ESLint);
breaking them fails CI.

## 1. Shell & Page Layout

- **Left navigation rail (`app.tsx`)**: Fixed `72px` icon-and-caption rail on `md:` and wider, with no
  expand/collapse control. Below `768px` (`md`), it collapses into a slide-over menu opened from the
  top mobile bar.
- **chief bot panel (`assistant.tsx`)**: A first-class column beside the page (not a floating bubble),
  full-width below `768px`.
- **Optional left secondary column** (e.g., `WorkflowPanel` on Runs, `palette` on Designer):
  - Width `w-56` (`224px`) when expanded on `lg:` (`>= 1024px`).
  - Collapsed strip (`w-9`) shown when closed **and** below `1024px` (`lg:hidden`), so tablet widths
    (`768–1023px`) never lose the column.
- **Standard scrolling page container**:
  - Use `className="page-width py-6"` with `data-testid="page-column"`.
  - `.page-width` already provides `mx-auto w-full max-w-[1760px] px-4 sm:px-6` — **do not** add extra
    `p-4` / `p-6` / `px-*` padding on top of `.page-width`.
  - Page title: `<h1 className="text-xl font-semibold">…</h1>` (with `mb-3` or `mb-4` spacing).
- **Responsive rule**: No page may scroll horizontally at `375px` viewport width. Tables scroll inside
  their own `overflow-x-auto` wrapper.

## 2. Right Side-Panels & Modals

- **Every "New …" / create-or-edit flow that lands in a listing is a right side-panel**, never an
  inline form card above the table.
- **Structure of a right slide-over panel**:
  - Backdrop (when modal): `fixed inset-0 z-40 bg-black/20` (clicking closes; Escape closes).
  - Container `<aside>`: `slide-in-right fixed inset-y-0 right-0 z-50 flex flex-col border-l border-slate-200 bg-surface shadow-2xl`
    (use `bg-page` instead of `bg-surface` only for multi-card detail panels like `run-panel`).
  - **Horizontally resizable**: Always wire `useRightPanelResize` + `PanelResizeHandle` from
    `packages/web/src/ui.tsx` (persisted in SQLite drafts under `ui:<name>-panel-width`, arrow keys +
    double-click reset, clamped to viewport).
  - **Header**: `flex shrink-0 items-center gap-2 border-b border-slate-200 px-4 py-2.5` with the
    panel title and a borderless close icon button (`variant="ghost" size="icon-sm"` with the 16 px
    SVG `×` icon — never a bordered `outline` box or raw `✕` text).
  - **Body**: `min-h-0 flex-1 overflow-y-auto px-4 py-3` (never put `overflow-auto` on `<aside>`
    itself, or the left-edge resize handle will clip and scroll).
  - **Footer** (when the panel has an action): `flex shrink-0 items-center gap-2 border-t border-slate-200 px-4 py-2.5`.
- **Modals (`Modal` in `ui.tsx`)**: Reserved for confirmations (delete confirmation) and focused
  import/export utilities, never for primary CRUD forms.

## 3. Button Taxonomy

Always use `<Button>` from `packages/web/src/components/ui/button.tsx` (or `<AsyncButton>` /
`<TrashButton>` from `packages/web/src/ui.tsx`). Never write raw `<button>` elements.

| Purpose | Component & Variant | Rules |
|---|---|---|
| **Primary action** (1 per view or panel) | `<Button variant="default">` or `<AsyncButton variant="default">` | Solid `bg-primary` block. Examples: *New input data set*, *Save data set*, *Start run*, *Create*, *Add schedule*, *Run*. |
| **Secondary action** | `<Button variant="outline">` or `<AsyncButton variant="outline">` | Bordered block. Examples: *Import*, *Export*, *Clone*, *Pause*, *Resume*, *Refine*, *Copy*, *Expand*, *Keep/Cancel* in dialogs. |
| **Icon / chrome button** | `<Button variant="ghost" size="icon-sm">` or `size="icon"` | Borderless icon trigger: close `×`, collapse/expand chevrons, prev/next arrows, history clock, `+` new chat. Always set `aria-label` and `title`. |
| **Inline text action** **(enforced)** | `<Button variant="link" className="h-auto px-0 …">` | Inline actions in prose, section headers, or table rows (*Clear the values*, *Ask chief bot*, *Start*, *Change its model*, *Keep it*). **Never** fake a link with `variant="ghost"` + `underline`. |
| **Remove / delete trigger** | `<TrashButton>` from `ui.tsx` | Always a quiet slate bin glyph that turns `--destructive` on hover. Never a filled red button. |
| **Destructive confirmation / non-delete hazard** | `<Button variant="destructive">` / `<AsyncButton variant="destructive">` | **Only** inside a confirmation dialog (*Delete run*, *Delete workflow*) or for non-delete high-impact actions (*Cancel run*, *Revert run*, *Reject gate*). |
| **Async server action** | `<AsyncButton>` from `ui.tsx` | Required for any button that awaits an HTTP request (shows a spinner and prevents double clicks). |

## 4. Themes, Color Schemes & Tokens

chief uses shadcn's semantic tokens mapped onto chief's themeable neutral ramp (`styles.css` +
`theme.ts`). Light and dark themes flip automatically by inverting `--surface`, `--page`, and the
`slate-*` ramp across all five selectable shadcn base schemes (**Neutral**, **Gray**, **Slate**,
**Stone**, **Zinc**).

- **Use semantic surfaces** **(enforced)**:
  - `bg-surface` (`var(--surface)`) for cards, sidebars, inputs, panels, and popovers.
  - `bg-page` (`var(--page)`) for the canvas/window background behind cards.
  - `bg-primary` / `text-primary-foreground`, `bg-accent` / `text-accent-foreground`, `border-border`.
- **Never use `bg-white` or arbitrary hex colors** (`bg-[#…]`, `text-[#…]`, `border-[#…]`) in
  `packages/web/src/` **(enforced)** — they break dark mode and ignore the chosen base palette.
  (Inside `components/ui/button.tsx` and `badge.tsx`, `text-white` on saturated `destructive`/`success`
  fills is allowed.)
- **Never write `dark:` twin classes** for standard surfaces/text: `styles.css` already inverts the
  neutral ramp and the end stops (`50–300`, `700–950`) of every semantic color family (`red`, `amber`,
  `green`, `emerald`, `teal`, `blue`, `orange`, `sky`, `purple`).
- **Status colors**: Use `STATUS_COLOR` from `api.ts` and `<Status>` from `ui.tsx`; never invent a
  second status palette.

## 5. Typography & Forms

- **Type scale**: Controlled by `--ui-scale` (`default: 0.9`, `large: 1`, `larger: 1.15`,
  `largest: 1.3`) using Geist Sans (`font-sans`) and Geist Mono (`font-mono` / `.mono`). Never set
  font sizes in raw `px`.
- **Autosave & drafts**: Edits to existing entities save themselves (no Save button). Creating a new
  input data set is the one deliberate exception (**Save data set**). Every text field persists a
  draft in SQLite via `useDraft` / `writeDraft` (never `localStorage` or `sessionStorage`).
- **Tooltips (`help.ts`)**: At most 6 lines and 420 characters, one sentence per line **(enforced)**.
