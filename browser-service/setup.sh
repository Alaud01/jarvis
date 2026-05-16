#!/bin/bash

set -e

echo "=== Browser Automation Service Setup ==="
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
python3 -m pip install --upgrade pip
python3 -m pip install -r "$SCRIPT_DIR/requirements.txt"

echo ""
echo "Installing Playwright browsers..."
python3 -m playwright install chromium

echo ""
echo "=== Setup Complete ==="
echo ""
echo "To run the browser service:"
echo "  cd browser-service"
echo "  source venv/bin/activate"
echo "  python3 -m uvicorn main:app --host 127.0.0.1 --port 8001"