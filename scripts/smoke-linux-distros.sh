#!/usr/bin/env bash
# Installs the CLI with install.sh inside containers of common Linux distributions and runs it.
#
#   bash scripts/smoke-linux-distros.sh [release-dir]
#
# release-dir defaults to dist/release and must contain the linux-x64 archives and SHA256SUMS.
# Requires Docker. Runs on x64 hosts. All distributions run in parallel; results print in order.
set -euo pipefail

release_dir="$(cd "${1:-dist/release}" && pwd)"
installer="$(cd "$(dirname "$0")" && pwd)/install.sh"
install_cmd='PORTIFACT_DOWNLOAD_URL=file:///rel PORTIFACT_INSTALL_DIR=/tmp/bin PORTIFACT_NO_MODIFY_PATH=1 bash /install.sh'
results="$(mktemp -d)"
trap 'rm -rf "$results"' EXIT
pids=()

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
    return 1
  fi
}

# Alpine without the C++ runtime: the installer must stop with an actionable message.
expect_missing_runtime_message() {
  local image="$1" output
  if output="$(in_container "$image" "apk add -q bash curl >/dev/null && $install_cmd")"; then
    printf 'FAIL  %-32s installer succeeded without libstdc++\n' "$image (no libstdc++)"
    return 1
  elif printf '%s' "$output" | grep -q 'apk add libstdc++ libgcc'; then
    printf 'ok    %-32s %s\n' "$image (no libstdc++)" "fails with install hint"
  else
    printf 'FAIL  %-32s\n%s\n' "$image (no libstdc++)" "$output"
    return 1
  fi
}

# Runs one check in the background; its report and exit status land in $results.
check() {
  local id
  id="$(printf '%02d' "${#pids[@]}")"
  { "$@" >"$results/$id.out" 2>&1 && echo 0 || echo 1; } >"$results/$id.status" &
  pids+=("$!")
}

check expect_success centos:7 true # glibc 2.17, the oldest glibc the binaries support
check expect_success buildpack-deps:bullseye-curl true
check expect_success buildpack-deps:bookworm-curl true
check expect_success buildpack-deps:focal-curl true
check expect_success buildpack-deps:noble-curl true
check expect_success rockylinux:8 true
check expect_success rockylinux/rockylinux:9 true
check expect_success fedora:latest true
check expect_success amazonlinux:2 'yum install -y -q tar gzip >/dev/null'
check expect_success amazonlinux:2023 'dnf install -y -q tar gzip >/dev/null'
check expect_success opensuse/leap:15.6 'zypper -q -n install tar gzip >/dev/null'
check expect_success alpine:3.20 'apk add -q bash curl libstdc++ libgcc >/dev/null'
check expect_missing_runtime_message alpine:3.20

wait "${pids[@]}"

failures=0
for out in "$results"/*.out; do
  cat "$out"
  if [ "$(cat "${out%.out}.status")" != 0 ]; then failures=$((failures + 1)); fi
done

if [ "$failures" -gt 0 ]; then
  echo "$failures distribution check(s) failed" >&2
  exit 1
fi
