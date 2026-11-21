# The desktop app: how it is built

The macOS app is an Electron window over the server `chief serve` runs (design: dev plan §3
"Desktop application"; tasks: §7 Phase 10). It is a package of its own, `packages/desktop`, that
imports neither the engine nor the web UI: it starts the server as a program and shows its page.

## Pieces

| File | What it does |
|---|---|
| `src/main.ts` | The main process: single-instance lock, window, menu, downloads, lifecycle |
| `src/sidecar.ts` | Starts `chief.mjs serve --port 0 --no-open` with the app's own binary as Node (`ELECTRON_RUN_AS_NODE=1`), reads the port from its first line, waits for `/api/meta`, stops it with SIGTERM then SIGKILL |
| `src/login-env.ts` | The login shell's environment (`$SHELL -ilc 'env -0'`), so the agent CLIs are found when the app is opened from the Finder |
| `src/navigation.ts` | What the window may do with a URL: stay on its origin, open `http(s)` links in the browser, refuse the rest |
| `src/status-page.ts` | The page shown when there is no server: starting, did not start (with its last lines), restarting |
| `src/locations.ts`, `src/log.ts` | `~/.chief/logs/chief.log` and Electron's profile in `~/.chief/desktop` |
| `scripts/build.ts` | Stages the app and, with `--package`, makes `dist/chief.app` and `dist/chief.dmg` |
| `scripts/dev.ts` | `npm run dev:desktop`: Vite with hot reload, the server under `node --watch`, and the app relaunched when the main process changes |
| `scripts/dev-bundle.ts` | The bundle a development run opens: a clone of `Electron.app` renamed chief, with chief's icon and an ad-hoc signature, so the menu bar and the Dock say chief (macOS takes both from the bundle, never from `app.setName`) |
| `scripts/make-icon.ts` | Renders `assets/icon.icns` from the web UI's logo (run again only when the logo changes) |
| `scripts/render-dmg-background.ts` | Renders `assets/dmg-background.png` from `assets/dmg-background.html` (run again only when the words change) |
| `assets/dmg-background.html` | The installer window's background, at the window's own size (600×400): *Drag chief into Applications* above the two icons, an arrow between them |
| `assets/dmg-background.png` | That page, committed. **600×400 pixels at 72 dpi** — Finder draws a background at its natural point size, which is its pixel size at 72 dpi, so any other size is drawn cropped or padded. The build only copies it, because `sips` cannot draw text and a build machine has no browser |
| `src/update.ts` | Finding a newer release and fetching its installer: the version comparison, which release counts, the download. No Electron imports, so the cases call it directly |

## Updates

The app asks GitHub for its newest release once at launch, and offers it when the version is higher
(`Check for Updates…` in the chief menu asks again on demand; `CHIEF_NO_UPDATE_CHECK=1` stops the
launch check, and `CHIEF_UPDATE_URL` points the check at another release list). **Download and Open**
saves the `.dmg` to `~/Downloads` and opens it, so the installer window appears and the update is the
same drag onto Applications as a first install. Nothing in `~/.chief` is touched.

**It does not install itself, on purpose.** Electron's `autoUpdater` is Squirrel.Mac on macOS, and
Squirrel checks the running app's signature against a Developer ID before applying an update; chief is
signed ad hoc (`codesign --force --deep --sign -`, no identity), so Squirrel would refuse. A silent
updater therefore needs an Apple Developer ID certificate and notarization first — an unsigned app that
replaced itself behind the signature check would not be an updater, it would be a hole. Until then the
check offers the installer, which is honest about what the app can do.

This one request per launch is the only traffic chief makes that is not the agent CLI's own. The
landing page and the README say so.

## Build

```sh
npm install
npm run build:desktop        # web UI, server bundle, then dist/chief.app and dist/chief.dmg
npm run build --workspace desktop      # only stage dist/desktop/ (what the e2e cases launch)
```

`npm run build` makes `dist/chief.mjs` and `dist/migrations/` (the server). The desktop step copies
them to `Contents/Resources/server/` and bundles `src/main.ts` into `main.cjs` with esbuild. There is
nothing native to rebuild and nothing nested to sign: the server is JavaScript run by Electron's own
signed binary.

The bundle is **signed ad hoc** (`codesign --sign -`, which is no identity): Apple silicon will not
start an unsigned binary, and changing the app's Info.plist invalidates the signature Electron ships
with. It is not notarized and has no Developer ID, so macOS blocks its first launch, and the README
gives the two ways through: **System Settings → Privacy & Security → Open Anyway** (the GUI path, and
since macOS 15 the only one — right-clicking the app and choosing Open no longer bypasses Gatekeeper),
and `xattr -dr com.apple.quarantine` for a terminal. `scripts/install-app.sh` is the third: it fetches
the release with `curl`, which does not set the quarantine flag at all, so the app it installs has
nothing to clear — the flag belongs to the downloading application, not the app. None of these change
what the app is: signing and notarizing is backlog item B.8, and it is the only thing that turns the
block into an ordinary "are you sure?" prompt.

The image is made to say what to do with it, three ways, so one of them always reaches a person. The
volume is named **chief — drag to Applications** (that is the Finder window's title bar, and it is there
even when the window cannot be arranged). The window draws the sentence **Drag chief into Applications**
with an arrow pointing at an `Applications` symlink to `/Applications` beside the app
(`assets/dmg-background.png`, a committed picture: `sips` cannot draw text and a build machine has no
browser). The picture is the window's size in pixels — 600×400 at 72 dpi — because Finder draws a
background at its natural point size: a 1200×800 picture is drawn at twice the window's size and a person
sees its top-left quarter. Its words live in `assets/dmg-background.html` and are rendered by
`npm run render:dmg-background --workspace desktop`, which also refuses a layout that runs off the window
or sits under an icon. Finder then writes the `.DS_Store` that fixes the window bounds, the icon size and the two
positions. A machine without Finder — CI — gets the same image with a warning in the log instead of a
failed build: the name, the shortcut and the picture are what the build must always provide, and the
layout is the part that needs a display session.

## The download, and how a build gets there

`dist/chief.dmg` is what people install. It is built in CI by `.github/workflows/desktop.yml` and
published as a release for the version it is: the asset is **`chief-<version>-apple-silicon.dmg`**
(`chief-0.2.0-apple-silicon.dmg`), beside `chief-0.2.0-apple-silicon.dmg.sha256`, whose content names
that same file so `shasum -a 256 -c` verifies it in whatever folder it was downloaded into. Nothing is
called `-latest`: the file says which version it is, and the tag is worth having (dev plan task 15.26).

The name says the Mac in words, not the machine's `arm64` — the same architecture (Apple silicon, M1
onwards; Intel is `x86_64`), but `arm64` is what `uname -m` answers in the runner check, not a word
anyone wants in their Downloads folder.

**The version in the manifest is the decision to ship.** Every push to `main` — a merged pull request
and a direct push are the same event — asks one question, in a first job on a Linux runner that costs
almost nothing:

1. what does `packages/desktop/package.json` say?
2. what is the highest `v*` tag in the repository (compared number by number, so `0.10.0` is newer than
   `0.9.0`)?
3. does a release exist for `v<version>` yet?

If the manifest's version is **higher** than the highest tag, that commit is a release: the workflow
creates the tag `v<version>` on it, builds the app, verifies the `.dmg`, and publishes a release titled
`chief <version>` whose notes are the version's own section of `CHANGELOG.md`. So shipping a version is
two steps, both ordinary git:

```sh
# in packages/desktop/package.json, "version": "0.2.0"
git commit -am "chief 0.2.0"
git push origin main        # the tag, the build and the release happen from here
```

If it is **not** higher, nothing is built and no macOS runner is spent: the run's summary says
`Nothing to build` and why. A README fix, a plan edit, a refactor or a dependency bump that does not
raise the version ships no new download — which is the point, and why there is no path filter to keep in
step with the app's sources.

**A tag that exists but has no release is built again.** A run can create the tag and then fail at the
build; the next push sees `v<version>` without a release and retries it, instead of the version being
silently skipped for ever.

**A release can also be built by hand**, which is what to use when a push produces no run — GitHub
stopped delivering `push` events for this repository for a while on 2026-11-20, and both workflows are
therefore startable with `gh workflow run` (task 15.30):

```sh
gh workflow run desktop -f version=0.2.0   # tag v0.2.0, build, verify, publish — no commit needed
gh workflow run ci                          # the gate on the newest commit, without pushing
```

**No review gate.** The version bump is the approval, so the `dmg` job does not run in an environment.
The `app-release` environment still exists in the repository and requires a review; nothing in this
workflow uses it, and `environment: app-release` on the `dmg` job is all it takes to bring an approval
step back.

**Old releases are pruned by hand, for now.** Every version keeps its release (that is what a versioned
download means), and nothing in the workflow deletes one. **Pruning loses no download count**: the
`downloads` workflow records each version's highest count in `downloads.json` (task 15.29), so the
numbers a pruned release had are already written down. Before pruning there is nothing to do; if the
last tally was a while ago, run it now, then delete:

```sh
gh workflow run downloads   # tally first, so the newest numbers are in the ledger
gh release delete v0.0.1 --yes
```

The ledger is a **file, not a database and not a service**: `downloads.json` at the repository root,
committed by the `downloads` workflow when the number changes (daily, on a published release, or on
demand). Each version keeps `max(recorded, seen now)`, and `total` is the sum of the versions, so the
number only ever grows — deleting a release cannot lower it, and a version that has been pruned keeps its
count. Its history is the file's git log, which is the audit trail. The tally commit says `[skip ci]`, and
`ci.yml` and `desktop.yml` ignore the path, so keeping the counter current never spends CI or a runner.
The landing page used to bake the number in when it built; the counter has since been removed from the
page entirely (it counts downloads of a build, not people using it), so nothing reads the ledger for
display. `downloads.json` is kept for the repository's own record.

What the workflow checks before anything is published: `plutil -lint`, the bundle identifier and the
version from the manifest, `codesign --verify --deep --strict`, `Signature=adhoc`, the server, its
migrations and the licence files inside the bundle, a `.dmg` that mounts and holds a runnable
executable, and a `shasum -a 256` under the published name (E15.16-1, E15.26-1).

**The landing page follows the newest release, from its own repository.** Because the asset is named
for its version, no page can hard-code a URL: [ccwukong/chief-site](https://github.com/ccwukong/chief-site)
reads the newest release's asset (`browser_download_url` and `size`, matched as
`chief-<version>-apple-silicon.dmg` so no version is written down there), builds the page and deploys it
to Cloudflare Pages at <https://runchief.dev>. It runs on a push there, once a day, and on demand — so a
release reaches the page within a day without a token shared across repositories.

## Develop with live reload

```sh
npm run dev:desktop
```

Three processes, and each picks up its own kind of change:

| What | Where | A change is in the app |
|---|---|---|
| The web UI, in Vite (hot module replacement) | http://127.0.0.1:5173 | without a reload |
| The server, from source, under `node --watch` | http://127.0.0.1:8080 | after it restarts in place |
| The main process, bundled by esbuild | `dist/desktop-dev/app/main.cjs` | after the app relaunches |

In this mode the window shows the Vite page (`CHIEF_DESKTOP_DEV_URL`) and starts no sidecar of its
own: the development loop owns the server. The Vite proxy reaches it as `127.0.0.1:8080` with its own
`Host` and `Origin`, so the server's guard accepts writes made from the page. The window is chief's
own bundle (`dist/desktop-dev/chief.app`, "The name and the icon" above), so the menu bar, the Dock
and the About panel are the ones a release shows. The mode is development only: `npm run
build:desktop` and the packaged app are unchanged.

The ports move with `CHIEF_DEV_API` (the server and the proxy's target) and `CHIEF_DEV_WEB_PORT`
(Vite), which is how the e2e case runs the loop beside whatever else is on the machine.

The app and the server share `~/.chief`, so quit the installed app before starting the dev loop (the
single-instance lock refuses a second window), and do not also run `npm run dev`: two servers
and two schedulers must never work over one database.

## Test it

The cases are in `e2e/desktop/` (Playwright's `desktop` project, which launches the staged app):

```sh
npx playwright test --project=desktop
```

They build what they need once. E10.5-1 also runs `npm run package --workspace desktop`, mounts the
`.dmg`, and starts a copy of the app from outside the checkout. E15.31-1 mounts the same image to check
what a person sees before installing anything: the volume's name, the `Applications` shortcut beside the
app, and the background picture that says *Drag chief into Applications*.
