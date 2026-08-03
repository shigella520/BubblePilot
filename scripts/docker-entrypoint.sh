#!/bin/sh
set -eu

node dist/app/migrate.js
exec node dist/app/main.js
