#!/usr/bin/env bash
# Portifact CLI installer for macOS and Linux.
#
#   curl -fsSL https://portifact.com/install | bash
#
# Environment variables:
#   PORTIFACT_VERSION         Version to install, for example 0.2.0. Defaults to the latest release.
#   PORTIFACT_INSTALL_DIR     Where to put the binary. Defaults to $HOME/.portifact/bin.
#   PORTIFACT_NO_MODIFY_PATH  Set to 1 to skip adding the install directory to your shell profile.
#   PORTIFACT_DOWNLOAD_URL    Base URL with the release assets. Used by tests; normally left unset.
set -euo pipefail

REPO="leynier/portifact"
TMP_DIR=""

info() { printf '%s\n' "$*"; }
fail() {
  printf 'error: %s\n' "$*" >&2
  exit 1
}

need() { command -v "$1" >/dev/null 2>&1 || fail "'$1' is required but was not found"; }

detect_target() {
  local os arch
  case "$(uname -s)" in
    Linux) os="linux" ;;
    Darwin) os="darwin" ;;
    *) fail "unsupported operating system: $(uname -s). On Windows, use install.ps1." ;;
  esac
  case "$(uname -m)" in
    x86_64 | amd64) arch="x64" ;;
    aarch64 | arm64) arch="arm64" ;;
    *) fail "unsupported architecture: $(uname -m)" ;;
  esac
  # An x64 shell running under Rosetta on Apple Silicon should still get the native build.
  if [ "$os" = "darwin" ] && [ "$arch" = "x64" ] && [ "$(sysctl -n sysctl.proc_translated 2>/dev/null || echo 0)" = "1" ]; then
    arch="arm64"
  fi
  local target="$os-$arch"
  if [ "$os" = "linux" ] && { [ -f /etc/alpine-release ] || ldd --version 2>&1 | grep -qi musl; }; then
    target="$target-musl"
  fi
  printf '%s' "$target"
}

# Musl builds link against the C++ runtime, which Alpine does not install by default.
check_musl_runtime() {
  local lib dir found
  for lib in libstdc++.so.6 libgcc_s.so.1; do
    found=0
    for dir in /usr/lib /lib /usr/local/lib; do
      if [ -e "$dir/$lib" ]; then found=1; fi
    done
    [ "$found" = 1 ] || fail "$lib is missing. On Alpine, install it first: apk add libstdc++ libgcc"
  done
}

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | cut -d ' ' -f 1
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | cut -d ' ' -f 1
  else
    fail "'sha256sum' or 'shasum' is required to verify the download"
  fi
}

add_to_path() {
  local dir="$1" profile line
  case "$(basename "${SHELL:-}")" in
    zsh) profile="$HOME/.zshrc" ;;
    bash) profile="$HOME/.bashrc" ;;
    fish) profile="$HOME/.config/fish/config.fish" ;;
    *) profile="$HOME/.profile" ;;
  esac
  if [ "$(basename "${SHELL:-}")" = "fish" ]; then
    line="fish_add_path \"$dir\""
  else
    line="export PATH=\"$dir:\$PATH\""
  fi
  if [ -f "$profile" ] && grep -Fq "$dir" "$profile"; then
    return
  fi
  mkdir -p "$(dirname "$profile")"
  printf '\n# Portifact\n%s\n' "$line" >>"$profile"
  info "Added $dir to PATH in $profile. Open a new terminal or run: $line"
}

main() {
  need curl
  need tar
  need uname

  local target archive base install_dir tmp expected actual
  target="$(detect_target)"
  archive="portifact-$target.tar.gz"
  case "$target" in *-musl) check_musl_runtime ;; esac

  if [ -n "${PORTIFACT_DOWNLOAD_URL:-}" ]; then
    base="$PORTIFACT_DOWNLOAD_URL"
  elif [ -n "${PORTIFACT_VERSION:-}" ]; then
    base="https://github.com/$REPO/releases/download/v${PORTIFACT_VERSION#v}"
  else
    base="https://github.com/$REPO/releases/latest/download"
  fi

  install_dir="${PORTIFACT_INSTALL_DIR:-$HOME/.portifact/bin}"
  tmp="$(mktemp -d)"
  TMP_DIR="$tmp"
  trap 'rm -rf "$TMP_DIR"' EXIT

  info "Downloading Portifact for $target..."
  curl -fsSL "$base/$archive" -o "$tmp/$archive" || fail "could not download $base/$archive"
  curl -fsSL "$base/SHA256SUMS" -o "$tmp/SHA256SUMS" || fail "could not download $base/SHA256SUMS"

  expected="$(awk -v name="$archive" '$2 == name { print $1 }' "$tmp/SHA256SUMS")"
  [ -n "$expected" ] || fail "no checksum published for $archive"
  actual="$(sha256_of "$tmp/$archive")"
  [ "$expected" = "$actual" ] || fail "checksum mismatch for $archive (expected $expected, got $actual)"

  tar -xzf "$tmp/$archive" -C "$tmp"
  mkdir -p "$install_dir"
  mv "$tmp/portifact" "$install_dir/portifact"
  chmod 755 "$install_dir/portifact"

  info "Installed portifact $("$install_dir/portifact" --version) to $install_dir/portifact"

  case ":$PATH:" in
    *":$install_dir:"*) ;;
    *)
      if [ "${PORTIFACT_NO_MODIFY_PATH:-0}" = "1" ]; then
        info "Add $install_dir to your PATH to use portifact."
      else
        add_to_path "$install_dir"
      fi
      ;;
  esac
}

main "$@"
