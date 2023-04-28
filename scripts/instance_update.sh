#!/bin/bash
source <( wget "http://169.254.169.254/latest/user-data" -O - 2>/dev/null )

SCRIPT_DIR=$( cd -- "$( dirname -- "${BASH_SOURCE[0]}" )" &> /dev/null && pwd )

if [ "${SC_UPDATE_URL}" != "" ]; then
  pushd $SC_REPO_DIR >/dev/null 2>/dev/null
  su node -c "${SCRIPT_DIR}/update_to_hash.sh ${SC_UPDATE_URL}" >>/tmp/instance-update.log 2>&1
  popd >/dev/null 2>/dev/null
fi
