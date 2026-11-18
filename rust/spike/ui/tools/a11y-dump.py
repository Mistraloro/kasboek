#!/usr/bin/python3.12
"""Prints the AT-SPI tree of the running spike window (what a Linux screen reader such as Orca would see).
Run with the system python (python3-pyatspi) inside a session bus and a display, see tools/a11y-dump.sh."""
import sys
import time

import pyatspi

def walk(node, depth=0):
    try:
        role = node.getRoleName()
        name = node.name
        states = [s.value_nick for s in node.getState().get_states()]
    except Exception as e:  # node vanished
        print("  " * depth + f"<error {e}>")
        return
    keep = [s for s in states if s in ("focused", "focusable", "selected", "selectable", "checked", "enabled", "showing")]
    print("  " * depth + f"[{role}] {name!r} {keep}")
    for i in range(node.childCount):
        walk(node.getChildAtIndex(i), depth + 1)

time.sleep(float(sys.argv[2]) if len(sys.argv) > 2 else 2)
desktop = pyatspi.Registry.getDesktop(0)
apps = [desktop.getChildAtIndex(i) for i in range(desktop.childCount)]
print("applications on the bus:", [a.name for a in apps if a])
for app in apps:
    if app and sys.argv[1] in (app.name or ""):
        walk(app)
