# Logos

The marks beside the CLI names in the README and on the landing page. They say which agent CLIs chief
drives; that is the only thing they are used for, and each belongs to its vendor.

| File | CLI | Where it came from |
|---|---|---|
| `claude.svg` | Claude Code | [Simple Icons](https://simpleicons.org) (`claude`), CC0 1.0. The mark is Claude's; the tile around it is ours |
| `cursor.svg` | Cursor | Simple Icons (`cursor`), CC0 1.0 |
| `opencode.svg` | OpenCode | Simple Icons (`opencode`), CC0 1.0 |
| `hermes.png` | Hermes | NousResearch/hermes-agent, the app's own icon (`apps/bootstrap-installer/src-tauri/icons/128x128.png`), MIT |

Simple Icons releases its *drawings* under CC0, which is what lets them be committed here; the trademarks
are the vendors' and are not licensed by it. Using a mark to say truthfully that software works with a
product is the usual nominative use, and it stops there: no logo here is used to suggest a vendor
endorses chief, and the tiles are neutral so a mark never borrows a brand's colour scheme.

## The two without a mark

**Codex** and **Antigravity** are named in both places and given no icon, on purpose:

- OpenAI's mark is no longer in Simple Icons — it was withdrawn — and going around that by scraping it
  from somewhere else would be exactly the thing being asked not to do.
- Antigravity has no separate mark to redistribute.

A drawn approximation would be worse than nothing: it would look official and be wrong. If a vendor
publishes assets for this use, drop the file in here, add a row to the table above, and add it to the
strip in `site/index.html` and `README.md` — `E15.20-6` fails while the two lists disagree.

## Adding one

Each file is a 24×24 tile: a rounded square (`#F1F3F6`) with the mark inset, so the same file reads on a
light page and a dark one. `node scripts/build-site.mjs` copies this folder to `site/dist/assets/logos/`,
so the page and the README show the same bytes.
