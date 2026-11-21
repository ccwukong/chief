#!/bin/sh
# Install the chief desktop app on an Apple silicon Mac.
#
#   curl -fsSL https://raw.githubusercontent.com/ccwukong/chief/main/scripts/install-app.sh | sh
#
# Why this exists: macOS marks a file as "downloaded from the internet" only when the *downloading
# application* asks it to — browsers and messengers do, `curl` does not. So an app fetched this way
# carries no `com.apple.quarantine` flag, and Gatekeeper has nothing to stop at first launch. That is
# the whole point: it is the one install path that needs no Terminal command afterwards and no
# "Open Anyway" trip through System Settings. It is also the reason this script never clears the flag
# itself — clearing another app's flag is what malware installers do, and it is not needed here.
#
# The app is still ad-hoc signed and not notarized (backlog B.8). This script does not change that;
# it only avoids the warning that an unsigned app's quarantine flag produces.
#
# Options (as arguments, when run from a file rather than piped):
#   --version <x.y.z>   install that release instead of the newest
#   --dir <path>        install into this directory instead of /Applications
#   --dry-run           say what would happen, download nothing

set -eu

REPO="ccwukong/chief"
VERSION=""
DEST="/Applications"
DRY_RUN=0

die() { printf 'chief: %s\n' "$1" >&2; exit 1; }
say() { printf '%s\n' "$1"; }

while [ $# -gt 0 ]; do
  case "$1" in
    --version) VERSION="${2:?--version needs a version, like 0.2.8}"; shift 2 ;;
    --dir) DEST="${2:?--dir needs a path}"; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    -h|--help) sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "unknown option: $1 (see --help)" ;;
  esac
done

# ── the Mac this is for ──────────────────────────────────────────────────────────────────────────
[ "$(uname -s)" = "Darwin" ] || die "this installs the macOS app; on another system build from source (npm run build) or use the CLI"
ARCH="$(uname -m)"
[ "$ARCH" = "arm64" ] || die "the published build is for Apple silicon (arm64); this Mac is $ARCH. Build from source instead: npm run build:desktop"

command -v curl >/dev/null 2>&1 || die "curl is needed to download the app"
command -v hdiutil >/dev/null 2>&1 || die "hdiutil is needed to open the disk image"

# ── which release ───────────────────────────────────────────────────────────────────────────────
# The newest tag from the redirect on /releases/latest, so no JSON parser is needed and the answer is
# the same one github.com/releases sends a browser to.
if [ -z "$VERSION" ]; then
  VERSION="$(curl -fsSLI -o /dev/null -w '%{url_effective}' "https://github.com/$REPO/releases/latest" 2>/dev/null | sed -n 's#.*/tag/v##p')"
  [ -n "$VERSION" ] || die "could not read the newest version from GitHub; pass --version x.y.z"
fi
case "$VERSION" in v*) VERSION="${VERSION#v}" ;; esac

ASSET="chief-$VERSION-apple-silicon.dmg"
BASE="https://github.com/$REPO/releases/download/v$VERSION"

say "chief $VERSION, Apple silicon"
say "  from $BASE/$ASSET"
say "  to   $DEST/chief.app"

if [ "$DRY_RUN" = "1" ]; then
  say "dry run: nothing downloaded, nothing installed"
  exit 0
fi

# ── download, and prove it is the file that was published ───────────────────────────────────────
WORK="$(mktemp -d "${TMPDIR:-/tmp}/chief-install.XXXXXX")"
mkdir -p "$WORK/mnt"
cleanup() {
  detach
  rm -rf "$WORK"
}
trap cleanup EXIT INT TERM

say "downloading…"
curl -fsSL -o "$WORK/$ASSET" "$BASE/$ASSET" || die "download failed: $BASE/$ASSET"
# The release publishes the digest beside the image, so a truncated or swapped file is caught here
# rather than at launch. A missing digest is a failure, not a warning.
curl -fsSL -o "$WORK/$ASSET.sha256" "$BASE/$ASSET.sha256" || die "the release has no .sha256 for $ASSET; refusing to install unverified"
( cd "$WORK" && shasum -a 256 -c "$ASSET.sha256" ) || die "the download does not match its published sha256; nothing was installed"

# ── copy the app into place ─────────────────────────────────────────────────────────────────────
# Two ways to mount, because `hdiutil attach -mountpoint` is deprecated and on macOS 26 fails outright
# with "Device not configured" (found 2026-11-21 by running it). `diskutil image attach` is the modern
# form; the plain `hdiutil attach` without `-mountpoint` is the fallback for older systems.
MOUNT=""
ATTACH_WITH=""
attach() {
  if diskutil image attach "$1" --mountOptions nobrowse --readOnly --mountPoint "$2" >/dev/null 2>&1; then
    MOUNT="$2"; ATTACH_WITH="diskutil"; return 0
  fi
  out="$(hdiutil attach "$1" -nobrowse -readonly 2>/dev/null)" || return 1
  found="$(printf '%s\n' "$out" | sed -n 's#.*\(/Volumes/.*\)#\1#p' | tail -1)"
  [ -n "$found" ] || return 1
  MOUNT="$found"; ATTACH_WITH="hdiutil"; return 0
}
detach() {
  [ -n "$MOUNT" ] || return 0
  if [ "$ATTACH_WITH" = "diskutil" ]; then diskutil eject "$MOUNT" >/dev/null 2>&1 || true
  else hdiutil detach "$MOUNT" >/dev/null 2>&1 || hdiutil detach "$MOUNT" -force >/dev/null 2>&1 || true; fi
}

attach "$WORK/$ASSET" "$MOUNT" || die "could not open the disk image"
[ -d "$MOUNT/chief.app" ] || die "the disk image has no chief.app in it"

mkdir -p "$DEST" 2>/dev/null || true
# /Applications is writable by an admin user; when it is not, ~/Applications is the sanctioned place
# for a per-user app and needs no sudo. Never silently escalate.
if [ ! -w "$DEST" ]; then
  DEST="$HOME/Applications"
  mkdir -p "$DEST"
  say "  ($DEST is not writable; installing to $DEST instead)"
fi

if [ -e "$DEST/chief.app" ]; then
  say "replacing $DEST/chief.app"
  # A running copy holds its files open and the copy below would leave a mixed bundle.
  if pgrep -x chief >/dev/null 2>&1; then
    say "  quitting the running chief first"
    osascript -e 'quit app "chief"' >/dev/null 2>&1 || true
    i=0
    while pgrep -x chief >/dev/null 2>&1 && [ "$i" -lt 20 ]; do i=$((i + 1)); sleep 0.5; done
    pgrep -x chief >/dev/null 2>&1 && die "chief is still running; quit it (⌘Q) and run this again"
  fi
  rm -rf "$DEST/chief.app"
fi

# `ditto` keeps the bundle's permissions and resource forks, and copies the signature as it is.
ditto "$MOUNT/chief.app" "$DEST/chief.app" || die "could not copy chief.app to $DEST"
detach

# A copy fetched with curl has no quarantine flag, and this says so rather than assuming it: if the
# flag is there (an older script, a manual download into the same place), print the one line that
# clears it instead of clearing it silently.
if xattr -p com.apple.quarantine "$DEST/chief.app" >/dev/null 2>&1; then
  say ""
  say "installed, but it carries the quarantine flag; clear it with:"
  say "  xattr -dr com.apple.quarantine \"$DEST/chief.app\""
else
  say ""
  say "installed: $DEST/chief.app — open it from Applications, Finder or Spotlight"
fi
say "The same data as the CLI: ~/.chief. The log is ~/.chief/logs/chief.log (Help → Reveal Log in Finder)."
