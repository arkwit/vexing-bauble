#!/bin/zsh

source .venv/bin/activate

npm run dev & (cd backend && fastapi run)