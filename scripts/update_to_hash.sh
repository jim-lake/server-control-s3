#!/bin/bash

if [ "$#" -lt 1 ]; then
  echo "Usage: $(basename $0) <url>"
  exit 1
fi

URL=$1
REPO_DIR=`pwd`
OLD_TARGET=$(readlink -fn "$REPO_DIR")
TARGET_NAME=$(basename "$REPO_DIR")
PARENT_DIR=$(dirname "$REPO_DIR")
ARCHIVE_NAME=${URL##*/}
ARCHIVE_BASE_NAME=${ARCHIVE_NAME%%.tar.gz}
DATE=$(date +%Y%m%d-%H%M%S)
TMP_DIR="$PARENT_DIR/$ARCHIVE_BASE_NAME-$DATE"

echo "updating repo with url: $URL"
echo " - mkdir for tmp dir: $TMP_DIR"
mkdir "$TMP_DIR"
if [ "$?" -ne 0 ]; then
  echo " - mkdir failed with parent $PARENT_DIR"
  exit 2
fi

pushd "$TMP_DIR"
echo " - downloading file to temp dir: $TMP_DIR"
if [[ $URL == http* ]] ; then
  wget "$URL" -O output.tar.gz
else
  aws s3 cp "$URL" output.tar.gz
fi
if [ "$?" -ne 0 ]; then
  echo " - pull $URL failed"
  rm -rf "$TMP_DIR"
  popd
  exit 3
fi

echo " - untar output.tar.gz"
tar xzf output.tar.gz
if [ "$?" -ne 0 ]; then
  echo " - untar failed"
  rm -rf "$TMP_DIR"
  popd
  exit 4
fi
rm output.tar.gz

echo " - npm ci"
npm ci
if [ "$?" -ne 0 ]; then
  echo " - npm ci failed"
  rm -rf "$TMP_DIR"
  popd
  exit 5
fi

echo " - link $TMP_DIR over $REPO_DIR"
if [[ $OSTYPE == darwin* ]]; then
  ln -shf "$TMP_DIR" "$REPO_DIR"
else
  ln -sTf "$TMP_DIR" "$REPO_DIR"
fi
if [ "$?" -ne 0 ]; then
  echo " - link failed"
  rm -rf "$TMP_DIR"
  popd
  exit 6
fi

rm -rf "$OLD_TARGET"

popd
exit 0
