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

Simple Icons releases its *drawings* under CC0, which is what lets them be committed here; the trademarks
are the vendors' and are not licensed by it. Using a mark to say truthfully that software works with a
product is the usual nominative use, and it stops there: no logo here is used to suggest a vendor
endorses chief, and the tiles are neutral so a mark never borrows a brand's colour scheme.

## The one without a mark

**Codex** is named in both places and given no icon, on purpose:

- OpenAI's mark is no longer in Simple Icons — it was withdrawn — and OpenAI's own
  [design guidelines](https://openai.com/brand/) grant only a conditional permission for their marks, with
  permission requests going to their partner team. Rather than take that decision here, Codex is named.

Antigravity used to be in this group and is not any more: it has a
[press kit](https://antigravity.google/press/) whose whole purpose is to be used, so `antigravity.svg` comes
from there. That is the difference — a published asset intended for this use, not a mark scraped from
elsewhere or drawn by hand. A drawn approximation would be worse than nothing: it would look official and be
wrong.

If OpenAI publishes assets for this kind of use, or you have their permission, drop the file in here, add a
row to the table above, add it to the strip in `site/index.html` and `README.md`, and update `E15.20-6`,
which fails while a CLI is in neither the strip nor this file.

## Adding one

Each file is a 24×24 tile: a rounded square (`#F1F3F6`) with the mark inset, so the same file reads on a
light page and a dark one. `node scripts/build-site.mjs` copies this folder to `site/dist/assets/logos/`,
so the page and the README show the same bytes.
