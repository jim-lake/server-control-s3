#!/bin/bash

if [ "$#" -lt 1 ]; then
  echo "Usage: $(basename $0) <repo_dir>"
  exit 1
fi

REPO_DIR=$1
REAL_REPO_DIR=$(readlink -fn "$REPO_DIR")

OLD_TARGET_FILE="$REPO_DIR/.sc_old_target"
if ! [[ -f "$OLD_TARGET_FILE" ]] ; then
  echo "Old target file doesnt exist, quitting"
  exit 0
fi

OLD_TARGET=$(cat "$OLD_TARGET_FILE")
if ! [[ -d "$OLD_TARGET" ]] ; then
  echo "Old target: $OLD_TARGET is not a dir, ignoring"
  rm -f "$OLD_TARGET_FILE"
  exit 0
fi

if [[ -L "$OLD_TARGET" ]]; then
  echo " - WARNING!!! Old Target: $OLD_TARGET is a link?!"
  rm -f "$OLD_TARGET_FILE"
  exit 0
fi

REAL_OLD_TARGET=$(readlink -fn "$OLD_TARGET")
if [[ "$REAL_REPO_DIR" = "$REAL_OLD_TARGET" ]] ; then
  echo "Old and new are the same, not removing"
  rm -f "$OLD_TARGET_FILE"
  exit 0
fi

echo "removing old target: $OLD_TARGET"
rm -rf "$OLD_TARGET"
if [ "$?" -ne 0 ]; then
  echo "Remove old target failed"
  exit 2
fi

rm -f "$OLD_TARGET_FILE"
exit 0
