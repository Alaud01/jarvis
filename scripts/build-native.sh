#!/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
NATIVE_DIR="$SCRIPT_DIR/../src/native"
BUILD_DIR="$SCRIPT_DIR/../build"

mkdir -p "$BUILD_DIR"

# Required for global Fn/Globe hotkey on macOS (see src/native/FnKeyMonitor.swift).
echo "Building FnKeyMonitor..."
swiftc -o "$BUILD_DIR/FnKeyMonitor" \
  "$NATIVE_DIR/FnKeyMonitor.swift" \
  -framework Cocoa -framework CoreGraphics \
  -Osize

echo "FnKeyMonitor built at $BUILD_DIR/FnKeyMonitor"