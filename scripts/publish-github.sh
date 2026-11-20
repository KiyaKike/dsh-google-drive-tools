#!/usr/bin/env bash
# Create the GitHub repository (if it does not exist yet) and push this checkout to it.
#
# Usage:
#   GH_TOKEN=github_pat_... GH_OWNER=your-login \
#     scripts/publish-github.sh [repo-name] [public|private]
#
# The token needs "Administration: write" (or classic repo scope) to create the repository and
# "Contents: write" to push. It is passed to git through an ephemeral URL and is never written
# into .git/config.
set -euo pipefail

: "${GH_TOKEN:?set GH_TOKEN to a GitHub token with repo creation and contents write access}"
: "${GH_OWNER:?set GH_OWNER to the GitHub user or organisation that should own the repository}"

REPO_NAME="${1:-dsh-google-drive-tools}"
VISIBILITY="${2:-public}"
case "$VISIBILITY" in public|private) ;; *) echo "visibility must be public or private" >&2; exit 2 ;; esac

cd "$(dirname "$0")/.."

BRANCH="$(git rev-parse --abbrev-ref HEAD)"
if [ "$BRANCH" = "HEAD" ]; then
  echo "the checkout has no branch; create one with: git checkout -b main" >&2
  exit 1
fi

API="https://api.github.com"
AUTH=(-H "Authorization: Bearer ${GH_TOKEN}" -H "Accept: application/vnd.github+json")

# 1. Create the repository unless it already answers.
if curl -sf "${AUTH[@]}" "${API}/repos/${GH_OWNER}/${REPO_NAME}" >/dev/null; then
  echo "repository ${GH_OWNER}/${REPO_NAME} already exists"
else
  echo "creating repository ${GH_OWNER}/${REPO_NAME} (${VISIBILITY})"
  curl -sf "${AUTH[@]}" -X POST "${API}/user/repos" \
    -d "{\"name\":\"${REPO_NAME}\",\"private\":$([ "$VISIBILITY" = private ] && echo true || echo false),\"description\":\"Read-write Google Drive tools for the DeepSeek Harness, over an existing rclone mount\"}" \
    >/dev/null || {
      echo "could not create ${REPO_NAME} under ${GH_OWNER}." >&2
      echo "If it belongs to an organisation, create it first (POST /orgs/${GH_OWNER}/repos) or via the web UI." >&2
      exit 1
    }
fi

# 2. Push through a one-off authenticated URL so the token stays out of .git/config.
git remote remove origin 2>/dev/null || true
git push "https://x-access-token:${GH_TOKEN}@github.com/${GH_OWNER}/${REPO_NAME}.git" "${BRANCH}:${BRANCH}" --set-upstream
git remote add origin "https://github.com/${GH_OWNER}/${REPO_NAME}.git"

echo "pushed ${BRANCH} to https://github.com/${GH_OWNER}/${REPO_NAME}"
