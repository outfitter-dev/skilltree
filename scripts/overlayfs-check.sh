#!/usr/bin/env bash
# Disposable mount fixture only. Run in a disposable Linux container/CI namespace.
set -euo pipefail
if [[ $(uname -s) != Linux || $(id -u) != 0 ]]; then
  echo 'Overlayfs regression requires root inside an isolated Linux test environment.' >&2
  exit 1
fi
fixture_root=$(mktemp -d /tmp/skilltree-overlay-XXXXXX)
cleanup() {
  umount "$fixture_root/view" 2>/dev/null || true
  umount "$fixture_root/upperfs" 2>/dev/null || true
  rmdir "$fixture_root/view" "$fixture_root/lower" "$fixture_root/upperfs" "$fixture_root" 2>/dev/null || true
}
trap cleanup EXIT
mkdir "$fixture_root/lower" "$fixture_root/upperfs" "$fixture_root/view"
mount -t tmpfs tmpfs "$fixture_root/upperfs"
mkdir "$fixture_root/upperfs/upper" "$fixture_root/upperfs/work"
mount -t overlay overlay -o "lowerdir=$fixture_root/lower,upperdir=$fixture_root/upperfs/upper,workdir=$fixture_root/upperfs/work,xino=off" "$fixture_root/view"
TMPDIR="$fixture_root/view" SKILLTREE_OVERLAY_FIXTURE=1 bun test --timeout 30000 "$@"
