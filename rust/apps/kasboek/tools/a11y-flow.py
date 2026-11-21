#!/usr/bin/env python3
"""Drives the real app through AT-SPI (as a screen reader or switch user would): Setup (password, recovery key with the
4-character confirmation, two-factor "Not now"), Lock, a wrong and the right password, Settings -> Security, and the pages that are
not ported yet (each shows its "not available" card). Invented password from argv. Run with the system python
(python3-pyatspi) inside a session bus and a display, see a11y-flow.sh."""
import base64
import hashlib
import hmac
import struct
import sys
import time

import pyatspi

def find(node, pred, out):
    try:
        if pred(node): out.append(node)
        for i in range(node.childCount): find(node.getChildAtIndex(i), pred, out)
    except Exception: pass
    return out

def app():
    d = pyatspi.Registry.getDesktop(0)
    for i in range(d.childCount):
        a = d.getChildAtIndex(i)
        if a and "kasboek" in (a.name or ""): return a

def wait(pred, what, t=30):
    end = time.time() + t
    while time.time() < end:
        a = app()
        if a:
            r = find(a, pred, [])
            if r: return r[0]
        time.sleep(0.2)
    a = app()
    print("TIMEOUT waiting for", what)
    def dump(n, d=0):
        try:
            print("  "*d, n.getRoleName(), repr(n.name))
            for i in range(n.childCount): dump(n.getChildAtIndex(i), d+1)
        except Exception as e: print('  '*d, '<error>', e)
    if a: dump(a)
    sys.exit(1)

def totp(secret, at=None):
    key = base64.b32decode(secret.replace(" ", "").upper())
    counter = int((time.time() if at is None else at) // 30)
    digest = hmac.new(key, struct.pack(">Q", counter), hashlib.sha1).digest()
    offset = digest[-1] & 15
    return "%06d" % ((struct.unpack(">I", digest[offset:offset + 4])[0] & 0x7FFFFFFF) % 1000000)

def named(role, name): return lambda n: n.getRoleName() == role and n.name == name
def click(role, name):
    n = wait(named(role, name), f"{role} {name}")
    # wait until enabled
    for _ in range(50):
        if n.getState().contains(pyatspi.STATE_ENABLED) and n.getState().contains(pyatspi.STATE_SENSITIVE): break
        time.sleep(0.1)
    n.queryAction().doAction(0)
def type_into(role, name, text):
    n = wait(named(role, name), f"{role} {name}")
    n.queryEditableText().setTextContents(text)

pw = sys.argv[1]
click("push button", "Use a password")
type_into("password text", "New password", pw)
type_into("password text", "Repeat password", pw)
click("push button", "Create and continue")
print("recovery screen reached")
key_node = wait(lambda n: n.getRoleName() in ("label","unknown") and n.name == "Recovery key" , "key")
desc = key_node.description
print("recovery key described (len):", len(desc))
tail = desc.split("-")[-1]
cont = wait(named("push button", "Continue"), "Continue")
print("continue enabled before ticking:", cont.getState().contains(pyatspi.STATE_ENABLED))
cb = wait(lambda n: n.getRoleName() in ("check box",) , "checkbox")
cb.queryAction().doAction(0)
time.sleep(0.3)
wait(lambda n: n.getRoleName()=="entry" and "last group" in (n.name or ""), "confirm field")
type_into("entry", "Type the last group of 4 characters to confirm", "WRNG")
time.sleep(0.2)
cont = wait(named("push button", "Continue"), "Continue")
print("continue enabled with wrong tail:", cont.getState().contains(pyatspi.STATE_ENABLED))
type_into("entry", "Type the last group of 4 characters to confirm", tail)
time.sleep(0.3)
cont = wait(named("push button", "Continue"), "Continue")
print("continue enabled with right tail:", cont.getState().contains(pyatspi.STATE_ENABLED))
cont.queryAction().doAction(0)
wait(named("push button", "Not now"), "2FA step")
print("2FA step reached")
# The secret is shown next to the QR code; the 6-digit field takes the code of this moment.
secret = wait(lambda n: n.getRoleName() in ("label", "unknown") and len((n.name or "").replace(" ", "")) == 32 and (n.name or "").replace(" ", "").isalnum() and (n.name or "").upper() == n.name, "secret").name
type_into("entry", "Enter the 6-digit code the app shows", totp(secret))
click("push button", "Turn on")
wait(named("push button", "Lock"), "unlocked shell (Lock nav)", 20)
print("2FA TURNED ON, UNLOCKED SHELL REACHED")

# Lock, a wrong password, the right one with its 6-digit code (a code is accepted once, so wait for the next 30 seconds).
click("push button", "Lock")
wait(named("push button", "Unlock"), "lock screen")
print("LOCK SCREEN REACHED")
time.sleep(31 - time.time() % 30)
type_into("password text", "Password", "Wrong-Password-12345")
type_into("entry", "6-digit code", totp(secret))
click("push button", "Unlock")
wait(lambda n: n.getRoleName() in ("label", "unknown") and "incorrect" in (n.name or "").lower(), "wrong password text")
print("WRONG PASSWORD SHOWN")
type_into("password text", "Password", pw)
type_into("entry", "6-digit code", totp(secret))
click("push button", "Unlock")
wait(named("push button", "Lock"), "unlocked again", 20)
print("UNLOCKED AGAIN")

# Settings (it opens on the General tab): the Security tab, then the pages that are not ported yet.
click("push button", "Settings")
click("push button", "Security")
wait(named("push button", "New recovery key…"), "security page")
print("SECURITY PAGE REACHED")
for page in ("Transactions", "Budgets", "Fixed costs", "Goals", "Year", "Net worth", "Import"):
    click("push button", page)
    wait(lambda n: n.getRoleName() in ("label", "unknown") and "Not available in this version yet" in (n.name or ""), f"{page} placeholder")
    print("PLACEHOLDER", page)
click("push button", "Overview")
wait(named("push button", "Lock"), "shell after the walk")
print("WALK DONE")
