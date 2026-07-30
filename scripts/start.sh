#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

echo "=== Aplicando migraciones de BD ==="
npm run db:migrate

echo ""
echo "=== Sembrando datos de ejemplo ==="
npm run db:seed

echo ""
echo "=== Iniciando servidor + UI ==="
npm run dev
