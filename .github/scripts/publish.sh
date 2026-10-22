#!/usr/bin/env bash
# Publishes one workspace package: publish.sh packages/<name>
#
# npm holds a package's first real release in a staged window for a few
# minutes. Until it lands, the publish fails with E409 "Cannot publish over
# previously staged version" and `npm view` shows nothing, though the release
# is accepted and appears unprompted. So that failure means "wait", and an
# "already published" one means a re-run after it landed; both pass only once
# `npm view` shows the version.
set -uo pipefail

dir="$1"
name=$(node -p "require('./$dir/package.json').name")
version=$(node -p "require('./$dir/package.json').version")
wait_seconds="${PUBLISH_WAIT_SECONDS:-1200}"
poll_seconds="${PUBLISH_POLL_SECONDS:-20}"

visible() {
  [ "$(npm view "$name@$version" version 2>/dev/null)" = "$version" ]
}

output=$(npm publish --workspace "$dir" --access public 2>&1)
status=$?
printf '%s\n' "$output"
[ "$status" -eq 0 ] && exit 0

if grep -q "You cannot publish over the previously published versions" <<<"$output"; then
  visible && { echo "$name@$version is already published."; exit 0; }
  echo "npm says $name@$version is published, but npm view cannot see it."
  exit 1
fi

if ! grep -q "Cannot publish over previously staged version" <<<"$output"; then
  exit "$status"
fi

echo "$name@$version is staged on npm; waiting up to ${wait_seconds}s for it to appear."
waited=0
while [ "$waited" -lt "$wait_seconds" ]; do
  sleep "$poll_seconds"
  waited=$((waited + poll_seconds))
  visible && { echo "$name@$version is published (after ${waited}s)."; exit 0; }
done
echo "$name@$version is staged on npm but never became visible after ${wait_seconds}s."
echo "Check https://www.npmjs.com/package/$name for a release awaiting approval, and"
echo "npm's status page; re-run this job once npm view $name@$version shows it."
exit 1
