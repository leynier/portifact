#!/usr/bin/env bash
# Installs the CLI with install.sh inside containers of common Linux distributions and runs it.
#
#   bash scripts/smoke-linux-distros.sh [release-dir]
#
# release-dir defaults to dist/release and must contain the linux-x64 archives and SHA256SUMS.
# Requires Docker. Runs on x64 hosts.
set -euo pipefail

release_dir="$(cd "${1:-dist/release}" && pwd)"
installer="$(cd "$(dirname "$0")" && pwd)/install.sh"
install_cmd='PORTIFACT_DOWNLOAD_URL=file:///rel PORTIFACT_INSTALL_DIR=/tmp/bin PORTIFACT_NO_MODIFY_PATH=1 bash /install.sh'
failures=0

in_container() {
  docker run --rm -v "$release_dir:/rel:ro" -v "$installer:/install.sh:ro" "$1" sh -c "$2" 2>&1
}

# image | setup command (the image must end up with bash, curl, tar and gzip)
expect_success() {
  local image="$1" setup="$2" output
  if output="$(in_container "$image" "$setup && $install_cmd >/dev/null && /tmp/bin/portifact --version")"; then
    printf 'ok    %-32s %s\n' "$image" "$(printf '%s' "$output" | tail -n 1)"
  else
    printf 'FAIL  %-32s\n%s\n' "$image" "$output"
    failures=$((failures + 1))
  fi
}

# Alpine without the C++ runtime: the installer must stop with an actionable message.
expect_missing_runtime_message() {
  local image="$1" output
  if output="$(in_container "$image" "apk add -q bash curl >/dev/null && $install_cmd")"; then
    printf 'FAIL  %-32s installer succeeded without libstdc++\n' "$image (no libstdc++)"
    failures=$((failures + 1))
  elif printf '%s' "$output" | grep -q 'apk add libstdc++ libgcc'; then
    printf 'ok    %-32s %s\n' "$image (no libstdc++)" "fails with install hint"
  else
    printf 'FAIL  %-32s\n%s\n' "$image (no libstdc++)" "$output"
    failures=$((failures + 1))
  fi
}

expect_success centos:7 true # glibc 2.17, the oldest glibc the binaries support
expect_success buildpack-deps:bullseye-curl true
expect_success buildpack-deps:bookworm-curl true
expect_success buildpack-deps:focal-curl true
expect_success buildpack-deps:noble-curl true
expect_success rockylinux:8 true
expect_success rockylinux/rockylinux:9 true
expect_success fedora:latest true
expect_success amazonlinux:2 'yum install -y -q tar gzip >/dev/null'
expect_success amazonlinux:2023 'dnf install -y -q tar gzip >/dev/null'
expect_success opensuse/leap:15.6 'zypper -q -n install tar gzip >/dev/null'
expect_success alpine:3.20 'apk add -q bash curl libstdc++ libgcc >/dev/null'
expect_missing_runtime_message alpine:3.20

if [ "$failures" -gt 0 ]; then
  echo "$failures distribution check(s) failed" >&2
  exit 1
fi
