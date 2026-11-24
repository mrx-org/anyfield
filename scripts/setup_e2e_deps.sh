#!/usr/bin/env bash
# Sets up everything tests/e2e/ needs to run headless Chromium via Playwright,
# including a workaround for machines without root/apt access (see
# tests/e2e/README.md for why this exists).
#
# Usage: bash scripts/setup_e2e_deps.sh
# Re-run any time to refresh; it's idempotent (re-downloads/re-extracts).
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LIBS_DIR="$REPO_ROOT/.pw-system-libs"

echo "[1/4] Installing Playwright's Chromium browser binary (pip package)..."
python -m playwright install chromium

echo "[2/4] Checking for missing shared libs Chromium needs to launch..."
CHROMIUM_BIN="$(python -c "
from playwright.sync_api import sync_playwright
with sync_playwright() as p:
    print(p.chromium.executable_path)
")"
MISSING_LIBS="$(ldd "$CHROMIUM_BIN" 2>/dev/null | awk '/not found/{print $1}')"

if [ -z "$MISSING_LIBS" ]; then
    echo "No missing libs -- system already has everything Chromium needs."
    exit 0
fi

echo "Missing libs: $MISSING_LIBS"

if sudo -n true 2>/dev/null; then
    echo "Passwordless sudo available -- using 'playwright install-deps' (the normal path)."
    sudo python -m playwright install-deps chromium
    exit 0
fi

echo "[3/4] No root/sudo -- downloading .deb packages directly and extracting"
echo "      them into a repo-local prefix ($LIBS_DIR, gitignored) instead."
echo "      This mirrors what 'playwright install-deps' would apt-install, just"
echo "      without touching the system -- see LD_LIBRARY_PATH usage below."

APT_TMP="$(mktemp -d)"
mkdir -p "$APT_TMP/lists/partial" "$APT_TMP/cache/archives/partial" "$LIBS_DIR"

apt-get -o Dir::State::Lists="$APT_TMP/lists" \
        -o Dir::Cache="$APT_TMP/cache" \
        -o Debug::NoLocking=1 \
        update

# Package names for Debian trixie/amd64 (Playwright's documented Chromium deps,
# https://playwright.dev/python/docs/browsers -- adjust names if the base image
# changes to a different Debian/Ubuntu release).
#
# fontconfig + fonts-dejavu-core are not optional here: with zero installed fonts
# Skia's fallback font manager aborts the browser process on the first text paint
# ("[FATAL:...SkFontMgr_FontConfigInterface.cpp] Not implemented."). fontconfig
# also brings the fc-cache binary used below.
PACKAGES=(
    libglib2.0-0t64 libnss3 libnspr4 libatk1.0-0t64 libatk-bridge2.0-0t64
    libdbus-1-3 libxcomposite1 libxdamage1 libxfixes3 libxrandr2 libgbm1
    libxkbcommon0 libasound2t64 libatspi2.0-0t64 libcups2t64 libpango-1.0-0
    libcairo2 fontconfig fonts-dejavu-core
)

apt-get -o Dir::State::Lists="$APT_TMP/lists" \
        -o Dir::Cache="$APT_TMP/cache" \
        -o Dir::Cache::Archives="$APT_TMP/cache/archives" \
        -o Debug::NoLocking=1 \
        install --download-only -y --no-install-recommends "${PACKAGES[@]}"

for deb in "$APT_TMP/cache/archives"/*.deb; do
    dpkg-deb -x "$deb" "$LIBS_DIR"
done
rm -rf "$APT_TMP"

# dpkg-deb -x skips maintainer scripts, so nothing has built the font index yet.
# Chromium would otherwise rescan every font on each launch; FONTCONFIG_SYSROOT
# (set by tests/e2e/conftest.py) makes both fc-cache and Chromium agree that
# /etc/fonts, /usr/share/fonts and /var/cache/fontconfig live under $LIBS_DIR.
echo ""
echo "[4/4] Warming the fontconfig cache inside $LIBS_DIR ..."
export LD_LIBRARY_PATH="$LIBS_DIR/usr/lib/x86_64-linux-gnu:${LD_LIBRARY_PATH:-}"
export FONTCONFIG_SYSROOT="$LIBS_DIR"
export FONTCONFIG_PATH="/etc/fonts"
mkdir -p "$LIBS_DIR/var/cache/fontconfig"
"$LIBS_DIR/usr/bin/fc-cache" -f
echo "Fonts fontconfig can see: $("$LIBS_DIR/usr/bin/fc-list" | wc -l)"
"$LIBS_DIR/usr/bin/fc-match" sans

echo ""
echo "Done. Verify with:"
echo "  LD_LIBRARY_PATH=\"$LIBS_DIR/usr/lib/x86_64-linux-gnu\" ldd \"$CHROMIUM_BIN\" | grep 'not found'"
echo "(no output = all resolved). tests/e2e/conftest.py sets LD_LIBRARY_PATH and the"
echo "FONTCONFIG_* vars automatically when $LIBS_DIR exists, so pytest tests/e2e/"
echo "should just work."
