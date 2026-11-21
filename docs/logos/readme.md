# Logos

The marks beside the CLI names in the README and on the landing page. They say which agent CLIs chief
drives; that is the only thing they are used for, and each belongs to its vendor.

| File | CLI | Where it came from |
|---|---|---|
| `claude.svg` | Claude Code | [Simple Icons](https://simpleicons.org) (`claude`), CC0 1.0. The mark is Claude's; the tile around it is ours |
| `cursor.svg` | Cursor | Simple Icons (`cursor`), CC0 1.0 |
| `opencode.svg` | OpenCode | Simple Icons (`opencode`), CC0 1.0 |
| `hermes.png` | Hermes | NousResearch/hermes-agent, the app's own icon (`apps/bootstrap-installer/src-tauri/icons/128x128.png`), MIT |
| `antigravity.svg` | Google Antigravity | [antigravity.google/press](https://antigravity.google/press/) — the official press kit's "Icon – Full Color" (`antigravity-icon__full-color.svg`), which exists to be used when saying what works with the product |
| `openai-black.svg`, `openai-white.svg` | Codex (OpenAI) | [OpenAI's brand kit](https://openai.com/brand/), `OpenAI-Logos-2025.zip` → `SVGs/OpenAI-{black,white}-monoblossom.svg`. **Byte-identical copies, no tile and no recolour**, because OpenAI's terms say to use the mark exactly as provided and to acknowledge that it belongs to OpenAI. The kit supplies a black and a white file for exactly this reason: the page shows the white one on the dark theme and the black one on the light theme, and the README uses a `<picture>` with `prefers-color-scheme` so GitHub's dark mode gets the white file too |

Simple Icons releases its *drawings* under CC0, which is what lets them be committed here; the trademarks
are the vendors' and are not licensed by it. Using a mark to say truthfully that software works with a
product is the usual nominative use, and it stops there: no logo here is used to suggest a vendor
endorses chief, and the tiles are neutral so a mark never borrows a brand's colour scheme.

## Every mark now comes from the vendor

There is no CLI in the strip without one. Each was taken from a source the vendor publishes for this use,
and the two that needed extra care are recorded here:

- **Codex / OpenAI** — [brand kit](https://openai.com/brand/), whose usage terms permit a third party to
  show the mark where it "directly relates to OpenAI services", used "exactly as provided", without
  implying endorsement. So: the official files, unmodified, no tile, black on the light page and white on
  the dark one — and nothing that suggests OpenAI endorses chief. The README and the page use the mark only
  beside the word "Codex", which is what it identifies. (The kit has no separate Codex logo; Codex is an
  OpenAI product, so its mark is the OpenAI one.)
- **Antigravity** — [press kit](https://antigravity.google/press/), published to be used.

A drawn approximation would be worse than nothing: it would look official and be wrong. If a vendor asks
for a mark to be removed, remove it and note why here; if it publishes assets for this use, add the file,
a row in the table above, and the strip entry, and update `E15.20-6` — which fails while a logo is in the
page but not in this file, or the reverse.

## Adding one

Each file is a 24×24 tile: a rounded square (`#F1F3F6`) with the mark inset, so the same file reads on a
light page and a dark one. `node scripts/build-site.mjs` copies this folder to `site/dist/assets/logos/`,
so the page and the README show the same bytes.
