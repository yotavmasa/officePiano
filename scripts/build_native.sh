#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
mkdir -p .build/swift-cache
swiftc -module-cache-path .build/swift-cache native/midi.swift -o native/midi \
  -framework CoreMIDI -framework AudioToolbox -framework CoreBluetooth
