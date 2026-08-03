#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 3 ]]; then
  echo "usage: $0 VERSION ARCH OUTPUT_DIR" >&2
  exit 2
fi

version="$1"
requested_arch="$2"
output_dir="$3"

if [[ ! "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+([-.+][0-9A-Za-z.-]+)?$ ]]; then
  echo "invalid release version: $version" >&2
  exit 2
fi

case "$requested_arch" in
  arm64)
    expected_machine="arm64"
    ;;
  x86_64)
    expected_machine="x86_64"
    ;;
  *)
    echo "unsupported release architecture: $requested_arch" >&2
    exit 2
    ;;
esac

actual_machine="$(uname -m)"
if [[ "$actual_machine" != "$expected_machine" ]]; then
  echo "runner architecture mismatch: expected $expected_machine, got $actual_machine" >&2
  exit 1
fi

package_version="$(bun -e 'console.log((await Bun.file("package.json").json()).version)')"
if [[ "$package_version" != "$version" ]]; then
  echo "tag/package version mismatch: tag=$version package.json=$package_version" >&2
  exit 1
fi

mkdir -p "$output_dir"
artifact="$output_dir/proxytop-${version}-darwin-${requested_arch}"
archive="${artifact}.tar.gz"

bun build --compile --outfile="$artifact" src/index.ts
test -x "$artifact"
tar -czf "$archive" -C "$output_dir" "$(basename "$artifact")"
shasum -a 256 "$archive" > "$archive.sha256"

echo "$archive"
echo "$archive.sha256"
