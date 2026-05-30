#!/bin/bash

set -e

echo "=== Voice Flow Setup Script ==="
echo ""

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VENV_DIR="$SCRIPT_DIR/venv"

if [ -d "$VENV_DIR" ]; then
    echo "Virtual environment already exists at $VENV_DIR"
else
    echo "Creating virtual environment..."
    python3 -m venv "$VENV_DIR"
fi

echo ""
echo "Activating virtual environment..."
source "$VENV_DIR/bin/activate"

echo ""
echo "Installing dependencies..."
pip install --upgrade pip
pip install -r "$SCRIPT_DIR/requirements.txt"

echo ""
echo "=== Setup Complete ==="
echo ""
echo "To run the voice service:"
echo "  cd python-service"
echo "  source venv/bin/activate"
echo "  python3 -m uvicorn main:app --host 127.0.0.1 --port 8765"
echo ""
echo "Or use: pnpm start:python (from root)"
