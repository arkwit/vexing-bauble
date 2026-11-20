#!/bin/zsh
set -e

source backend/.venv/bin/activate

npm run dev & (cd backend && fastapi run)