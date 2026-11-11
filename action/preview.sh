#!/usr/bin/env bash
# The Portifact pull request preview action (action.yml): every step runs one subcommand of this
# script, and the tests in scripts/github-action.test.ts source it to check each function.
#
#   preview.sh plan      decide what this event does; writes mode, key and cli-version
#   preview.sh install   install the released CLI with the repository's installer (macOS, Linux)
#   preview.sh publish   publish the preview by key, then create or update the pull request comment
#   preview.sh delete    delete the preview by key, then update the comment
#
# Values from the event (title, number, commit) and the inputs arrive in environment variables,
# never in the script's text. The token is PORTIFACT_TOKEN, read only by the CLI; nothing here
# prints, stores or passes it on. Without a token, the workspace input turns on GitHub Actions
# OIDC (decision 0024): the CLI exchanges the run's ID token itself (PORTIFACT_GITHUB_OIDC), and
# this script only checks that the job may ask GitHub for one.
set -euo pipefail

PF_KEY_PATTERN='^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$'
PF_WORKSPACE_PATTERN='^[a-z0-9][a-z0-9-]{0,62}$'
PF_NAME_MAX_BYTES=200
PF_MARKER_PREFIX='<!-- portifact-preview:'

# A workflow command (::notice:: and the like) with its message escaped as GitHub documents, so a
# message from elsewhere cannot end the command and start another one.
pf_command() {
  local kind="$1" message="$2"
  message="${message//'%'/'%25'}"
  message="${message//$'\r'/'%0D'}"
  message="${message//$'\n'/'%0A'}"
  printf '::%s::%s\n' "$kind" "$message" >&2
}

pf_fail() {
  pf_command error "$1"
  exit 1
}

pf_is_true() {
  case "$1" in
    true | True | TRUE) return 0 ;;
    false | False | FALSE | "") return 1 ;;
    *) pf_fail "expected true or false, got '$1'" ;;
  esac
}

# What the event does: publish, delete or skip. A pull request from a fork gets no secrets and no
# ID token, so without a credential the preview is skipped with a warning, or fails when
# fail-without-token is set. `credential` is non-empty when a token is set or, in OIDC mode
# (`via` is oidc), when the job can ask GitHub for an ID token.
pf_decide() {
  local event="$1" action="$2" token="$3" delete_on_close="$4" fail_without_token="$5" via="${6:-token}"
  if [ "$event" = "pull_request_target" ]; then
    pf_fail "This action refuses pull_request_target: that event hands secrets to a run that may build the fork's code. Use the pull_request event."
  fi
  if [ "$event" != "pull_request" ]; then
    pf_fail "This action runs on pull_request events, not '$event'."
  fi
  local mode
  case "$action" in
    opened | synchronize | reopened) mode="publish" ;;
    closed)
      if pf_is_true "$delete_on_close"; then mode="delete"; else mode="skip"; fi
      ;;
    *) mode="skip" ;;
  esac
  if [ "$mode" != "skip" ] && [ -z "$token" ]; then
    local message="No Portifact token: the token input is empty. Pull requests from forks get no secrets, so their previews are skipped. Otherwise add the PORTIFACT_TOKEN secret to the repository."
    if [ "$via" = "oidc" ]; then
      message="No GitHub ID token: this job cannot ask GitHub for one. Pull requests from forks get none, so their previews are skipped. Otherwise give the job 'permissions: id-token: write'."
    fi
    if pf_is_true "$fail_without_token"; then pf_fail "$message"; fi
    pf_command warning "$message"
    mode="skip"
  fi
  printf '%s' "$mode"
}

# The workspace input of the OIDC mode: a workspace slug, or empty.
pf_workspace() {
  local value="$1"
  if [ -z "$value" ]; then return 0; fi
  [[ "$value" =~ $PF_WORKSPACE_PATTERN ]] || pf_fail "The workspace input must be a workspace slug, such as acme."
  printf '%s' "$value"
}

# The key prefix a run's credential is restricted to (decision 0024): gh-<repository ID>/.
pf_oidc_prefix() {
  local id="$1"
  [[ "$id" =~ ^[1-9][0-9]{0,19}$ ]] || pf_fail "GITHUB_REPOSITORY_ID is missing; the OIDC mode runs only in GitHub Actions."
  printf 'gh-%s/' "$id"
}

pf_valid_key() {
  [[ "$1" =~ $PF_KEY_PATTERN ]]
}

# The publish key: the input, or <prefix>pr-<number> (the prefix is the OIDC mode's namespace).
pf_key() {
  local input="$1" number="$2" prefix="${3:-}" key
  if [ -n "$input" ]; then
    key="$input"
  else
    [[ "$number" =~ ^[1-9][0-9]{0,9}$ ]] || pf_fail "The pull request number is missing; set the key input."
    key="${prefix}pr-$number"
  fi
  pf_valid_key "$key" || pf_fail "The key must be 1 to 128 letters, digits, '.', '_', '/' or '-', starting with a letter or digit."
  if [ -n "$prefix" ] && [ "${key#"$prefix"}" = "$key" ]; then
    pf_fail "In the OIDC mode the key must start with $prefix, the repository's namespace."
  fi
  printf '%s' "$key"
}

# The artifact's name: the input, or "PR #<number>: <title>", without control characters and cut
# to the CLI's 200-byte limit on a character boundary.
pf_name() {
  local input="$1" title="$2" number="$3" name
  if [ -n "$input" ]; then
    name="$input"
  elif ! [[ "$number" =~ ^[1-9][0-9]{0,9}$ ]]; then
    pf_fail "The pull request number is missing; set the name input."
  elif [ -n "$title" ]; then
    name="PR #$number: $title"
  else
    name="PR #$number"
  fi
  printf '%s' "$name" | LC_ALL=C tr -d '\000-\037\177' | head -c "$PF_NAME_MAX_BYTES" | iconv -c -f UTF-8 -t UTF-8
}

# The CLI version to install: the input (a version, or latest), else the version in the CLI's
# manifest next to the action, which is the release the action's tag or commit belongs to.
pf_cli_version() {
  local input="$1" action_path="$2" version
  if [ "$input" = "latest" ]; then
    return 0
  fi
  if [ -n "$input" ]; then
    version="${input#v}"
  else
    local manifest="$action_path/../packages/cli/package.json"
    [ -f "$manifest" ] || pf_fail "Cannot find the CLI manifest next to the action; set the cli-version input."
    version="$(sed -n 's/^  "version": "\([^"]*\)".*/\1/p' "$manifest" | head -n 1)"
  fi
  [[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || pf_fail "cli-version must be a released version such as 1.2.3, or latest."
  printf '%s' "$version"
}

# Text for the comment with every character Markdown or HTML would act on escaped, so a value
# can never become a link, an image, a mention, markup or a hidden comment.
pf_md_text() {
  local text="$1" out="" char i
  text="$(printf '%s' "$text" | LC_ALL=C tr -d '\000-\037\177')"
  for ((i = 0; i < ${#text}; i++)); do
    char="${text:i:1}"
    case "$char" in
      '&') out+='&amp;' ;;
      '<') out+='&lt;' ;;
      '>') out+='&gt;' ;;
      '"') out+='&quot;' ;;
      '@') out+='&#64;' ;;
      ':') out+='&#58;' ;;
      \\ | '`' | '*' | '_' | '[' | ']' | '(' | ')' | '#' | '!' | '|' | '~' | '{' | '}' | '+' | '-' | '.') out+="\\$char" ;;
      *) out+="$char" ;;
    esac
  done
  printf '%s' "$out"
}

pf_valid_url() {
  [[ "$1" =~ ^https?://[A-Za-z0-9.-]+(:[0-9]{1,5})?(/[A-Za-z0-9._~/%-]*)?$ ]]
}

pf_marker() {
  printf '%s%s -->' "$PF_MARKER_PREFIX" "$1"
}

# The comment's body. state is published or removed; url, version and commit come from the CLI
# and the event and are checked before they are written.
pf_comment_body() {
  local state="$1" key="$2" url="${3:-}" version="${4:-}" commit="${5:-}" commit_url="${6:-}"
  pf_valid_key "$key" || pf_fail "invalid key"
  printf '%s\n### Portifact preview\n\n' "$(pf_marker "$key")"
  if [ "$state" = "removed" ]; then
    printf 'The preview %s was removed when the pull request closed.\n' "$(pf_md_text "$key")"
    return 0
  fi
  pf_valid_url "$url" || pf_fail "The CLI returned an unexpected URL."
  [[ "$version" =~ ^[1-9][0-9]*$ ]] || pf_fail "The CLI returned an unexpected version."
  printf '[Open the preview](%s)\n\n' "$url"
  printf '| Key | Version | Commit |\n| --- | --- | --- |\n'
  local commit_cell="unknown"
  if [[ "$commit" =~ ^[0-9a-f]{40}$ ]]; then
    commit_cell="\`${commit:0:7}\`"
    if pf_valid_url "$commit_url"; then commit_cell="[$commit_cell]($commit_url)"; fi
  fi
  printf '| %s | %s | %s |\n\n' "$(pf_md_text "$key")" "$version" "$commit_cell"
  printf 'The preview keeps the access its workspace gives new artifacts: sign in to Portifact with an account that may read it.\n'
}

# jq without the carriage returns a Windows build may write.
pf_jq() {
  jq "$@" | tr -d '\r'
}

pf_gh() {
  "${PORTIFACT_GH:-gh}" "$@"
}

pf_need() {
  command -v "$1" >/dev/null 2>&1 || pf_fail "'$1' is required on the runner but was not found."
}

# The ID of the bot comment on the pull request that starts with this key's marker, if any.
pf_find_comment() {
  local repo="$1" number="$2" marker="$3" pages
  pages="$(pf_gh api --paginate "repos/$repo/issues/$number/comments?per_page=100")" || return 1
  # shellcheck disable=SC2016 # $marker is a jq variable, not a shell one
  printf '%s' "$pages" | pf_jq -rs --arg marker "$marker" \
    '[.[][] | select(.user.type == "Bot") | select((.body // "") | startswith($marker))] | first | .id // empty'
}

# Updates the key's comment, or creates it when create is true. A failure is a warning: the
# preview itself already succeeded, and the comment is a convenience.
pf_upsert_comment() {
  local repo="$1" number="$2" key="$3" body="$4" create="$5" id
  if ! id="$(pf_find_comment "$repo" "$number" "$(pf_marker "$key")")"; then
    pf_command warning "Could not read the pull request's comments. Give the job 'pull-requests: write'."
    return 0
  fi
  if [ -n "$id" ]; then
    [[ "$id" =~ ^[0-9]+$ ]] || pf_fail "unexpected comment ID"
    pf_gh api --method PATCH "repos/$repo/issues/comments/$id" -f "body=$body" >/dev/null ||
      pf_command warning "Could not update the preview comment. Give the job 'pull-requests: write'."
  elif [ "$create" = "true" ]; then
    pf_gh api --method POST "repos/$repo/issues/$number/comments" -f "body=$body" >/dev/null ||
      pf_command warning "Could not comment on the pull request. Give the job 'pull-requests: write'."
  fi
}

pf_output() {
  if [ -n "${GITHUB_OUTPUT:-}" ]; then printf '%s=%s\n' "$1" "$2" >>"$GITHUB_OUTPUT"; fi
}

pf_summary() {
  if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then printf '%s\n' "$1" >>"$GITHUB_STEP_SUMMARY"; fi
}

pf_cli() {
  local bin="${PORTIFACT_BIN:-}"
  if [ -z "$bin" ]; then
    bin="${RUNNER_TEMP:?}/portifact-cli/portifact"
    if [ "${RUNNER_OS:-}" = "Windows" ]; then
      bin="$bin.exe"
      if command -v cygpath >/dev/null 2>&1; then bin="$(cygpath -u "$bin")"; fi
    fi
  fi
  "$bin" "$@"
}

# Runs the CLI with --json and prints its output; on failure reports the CLI's error message and
# exits with the CLI's code.
pf_cli_json() {
  local out status=0
  out="$(pf_cli "$@" --json)" || status=$?
  if [ "$status" -ne 0 ]; then
    local message
    message="$(printf '%s' "$out" | pf_jq -r '.error.message // empty' 2>/dev/null || true)"
    pf_command error "portifact $1 failed (exit $status): ${message:-see the log above}"
    exit "$status"
  fi
  printf '%s' "$out"
}

pf_valid_repo() {
  [[ "$1" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || pf_fail "unexpected repository name"
}

pf_main_plan() {
  local mode key version workspace via="token" credential="${PF_TOKEN_SET:-}" prefix=""
  workspace="$(pf_workspace "${PF_WORKSPACE:-}")"
  if [ -z "$credential" ] && [ -n "$workspace" ]; then
    via="oidc"
    if [ -n "${ACTIONS_ID_TOKEN_REQUEST_URL:-}" ]; then credential="yes"; fi
  fi
  mode="$(pf_decide "${GITHUB_EVENT_NAME:-}" "${PF_ACTION:-}" "$credential" "${PF_DELETE_ON_CLOSE:-true}" "${PF_FAIL_WITHOUT_TOKEN:-false}" "$via")"
  pf_output mode "$mode"
  if [ "$mode" = "skip" ]; then
    return 0
  fi
  if [ "$via" = "oidc" ]; then prefix="$(pf_oidc_prefix "${GITHUB_REPOSITORY_ID:-}")"; fi
  key="$(pf_key "${PF_INPUT_KEY:-}" "${PF_NUMBER:-}" "$prefix")"
  version="$(pf_cli_version "${PF_CLI_VERSION:-}" "${GITHUB_ACTION_PATH:?}")"
  pf_output key "$key"
  pf_output cli-version "$version"
}

pf_main_install() {
  PORTIFACT_VERSION="${PF_CLI_VERSION:-}" \
    PORTIFACT_INSTALL_DIR="${RUNNER_TEMP:?}/portifact-cli" \
    PORTIFACT_NO_MODIFY_PATH=1 \
    bash "${GITHUB_ACTION_PATH:?}/../scripts/install.sh"
}

pf_main_publish() {
  pf_need jq
  local key name out url id version repo number
  key="${PF_KEY:?}"
  pf_valid_key "$key" || pf_fail "invalid key"
  [ -n "${PF_PATH:-}" ] || pf_fail "Set the path input to the folder or file to publish."
  name="$(pf_name "${PF_INPUT_NAME:-}" "${PF_TITLE:-}" "${PF_NUMBER:-}")"
  out="$(pf_cli_json publish "$PF_PATH" "--key=$key" "--name=$name")"
  url="$(printf '%s' "$out" | pf_jq -r '.url // empty')"
  id="$(printf '%s' "$out" | pf_jq -r '.artifactId // empty')"
  version="$(printf '%s' "$out" | pf_jq -r '.versionNumber // empty')"
  pf_valid_url "$url" || pf_fail "The CLI returned an unexpected URL."
  [[ "$id" =~ ^[A-Za-z0-9_-]{1,64}$ ]] || pf_fail "The CLI returned an unexpected artifact ID."
  [[ "$version" =~ ^[1-9][0-9]*$ ]] || pf_fail "The CLI returned an unexpected version."
  pf_output url "$url"
  pf_output artifact-id "$id"
  pf_output version "$version"
  pf_summary "Published the Portifact preview \`$key\`, version $version: $url"
  if pf_is_true "${PF_COMMENT:-true}"; then
    repo="${GITHUB_REPOSITORY:?}"
    number="${PF_NUMBER:?}"
    pf_valid_repo "$repo"
    local commit="${PF_SHA:-}"
    local body
    body="$(pf_comment_body published "$key" "$url" "$version" "$commit" "${GITHUB_SERVER_URL:-https://github.com}/$repo/commit/$commit")"
    pf_upsert_comment "$repo" "$number" "$key" "$body" true
  fi
}

pf_main_delete() {
  pf_need jq
  local key out deleted
  key="${PF_KEY:?}"
  pf_valid_key "$key" || pf_fail "invalid key"
  out="$(pf_cli_json delete "--key=$key" --yes)"
  deleted="$(printf '%s' "$out" | pf_jq -r '.deleted')"
  if [ "$deleted" = "true" ]; then
    pf_summary "Deleted the Portifact preview \`$key\`."
  else
    pf_summary "No Portifact preview had the key \`$key\`; nothing to delete."
  fi
  if pf_is_true "${PF_COMMENT:-true}"; then
    local repo="${GITHUB_REPOSITORY:?}"
    pf_valid_repo "$repo"
    pf_upsert_comment "$repo" "${PF_NUMBER:?}" "$key" "$(pf_comment_body removed "$key")" false
  fi
}

if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  case "${1:-}" in
    plan) pf_main_plan ;;
    install) pf_main_install ;;
    publish) pf_main_publish ;;
    delete) pf_main_delete ;;
    *) pf_fail "usage: preview.sh plan|install|publish|delete" ;;
  esac
fi
