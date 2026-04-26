#!/usr/bin/env bash
# Seed OWNER / ADMIN / MEMBER demo users (see prisma/seed.ts).
set -euo pipefail
cd "$(dirname "$0")/.."
npm run seed:users
