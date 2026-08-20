#!/usr/bin/env bash

set -Eeuo pipefail

installer_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
cd "$installer_root"

if ! command -v node >/dev/null 2>&1; then
  echo "Agent Switchboard needs Node.js 22.5 or newer." >&2
  echo "Install Node.js, then run ./install.sh again." >&2
  exit 1
fi

if ! command -v npm >/dev/null 2>&1; then
  echo "Agent Switchboard needs npm (normally included with Node.js)." >&2
  echo "Install npm, then run ./install.sh again." >&2
  exit 1
fi

exec npm run install:user -- "$@"
