#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PORT="${PORT:-8000}"

if ! command -v npm >/dev/null 2>&1; then
  echo "npm is required to build the frontend."
  exit 1
fi

if [ ! -d "$ROOT_DIR/frontend/node_modules" ]; then
  echo "Frontend dependencies are missing. Run: cd frontend && npm install"
  exit 1
fi

if [ ! -f "$ROOT_DIR/backend/.venv/bin/activate" ]; then
  echo "Backend virtualenv is missing. Run:"
  echo "  cd backend"
  echo "  python3 -m venv .venv"
  echo "  source .venv/bin/activate"
  echo "  pip install -r requirements.txt"
  exit 1
fi

echo "Building frontend..."
(cd "$ROOT_DIR/frontend" && npm run build)

echo "Starting Voxly at http://127.0.0.1:$PORT"
echo "Ollama should already be running for local AI correction."
cd "$ROOT_DIR/backend"
source .venv/bin/activate
if [ "${VOXLY_RELOAD:-0}" = "1" ]; then
  exec uvicorn app.main:app --reload --host 127.0.0.1 --port "$PORT"
fi

exec uvicorn app.main:app --host 127.0.0.1 --port "$PORT"
