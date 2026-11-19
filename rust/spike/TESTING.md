# Testing the Rust spikes on your own computer

What this is: small test programs, not the real Kasboek. They show the lock screen and the overview, and can ask Windows
Hello / Touch ID, but nothing is unlocked and no real data is read. All text and data are invented. Nothing is sent anywhere.
Plain-language checklist; reply with the table at the end (a photo of the filled table is fine).

## 1. Download and start

1. GitHub, the repository, tab **Actions**, workflow **Rust spikes**, the newest run with a green mark (a yellow mark is also
   fine: it means a self-check failed, the run summary says which). Scroll to **Artifacts** at the bottom and click
   `kasboek-spike-ui-<system>-<chip>`:
   `windows-x64` (normal PC), `windows-arm64` (Snapdragon PC), `macos-arm64` (Mac with M1 or newer), `macos-x64` (older Intel Mac).
   Unsure? Windows: Settings > System > About > "System type". Mac: Apple menu > About This Mac.
2. **Windows:** right-click the downloaded zip > Extract All. Double-click `start-ui.cmd`.
   Blue "Windows protected your PC" (SmartScreen): click **More info**, then **Run anyway**.
3. **Mac:** double-click the zip, then the `.tar` inside; a folder `ui` appears. Open **Terminal**, type `cd ` (with the space), drag the
   folder `ui` into the Terminal window, press Enter, then type these two lines (Enter after each):
   `xattr -dr com.apple.quarantine .` and `./start-ui.sh`.
   If a message says the program cannot be opened: System Settings > Privacy & Security > scroll down > **Open Anyway**, then run `./start-ui.sh` again.
4. A window "Kasboek" opens with the lock screen. Close it with the window's close button. Every start writes
   **startup.log** in the same folder (the run before is `startup.prev.log`). Copy it somewhere before the next start if you want to keep it.
5. Extra options after the start command, for example `start-ui.cmd --lang de --theme dark --scale 2`
   (`--lang en|de|fr`, `--theme light|dark`, `--scale 1|2`, `--screen lock-password|lock-hello|overview`).
   Windows: type `cmd` in the folder's address bar and press Enter, then type the command. Mac: `./start-ui.sh` plus the options. Below, "`start-ui`" means this.

## 2. First frame time (how fast the window appears)

startup.log has lines like `   312 ms  time-to-first-frame 312 ms`. The number is milliseconds since Windows/macOS created the process. Goal: 500 or less.
Do these in this order and note the number each time:
- **First run after download** (Windows Defender scans new files, so it is slower; do this before anything else).
- **Cold:** restart the computer, wait a minute, open nothing else, start `start-ui`. Note the number.
- **Warm:** close and start again 3 times; note the three numbers.
Also note the line `process start (OS creation time; main entered ... ms later)`: it shows how long Windows took before the program's own code ran.

## 3. Windows Hello / Touch ID button

Needs Windows Hello (Settings > Accounts > Sign-in options, fingerprint, face or PIN) or a Mac with Touch ID.
1. Start `start-ui`. Click **Unlock with Windows Hello** (Mac: **Unlock with Touch ID**). Count roughly how long until the system prompt appears (goal: under 1 second).
2. Answer it correctly. The screen shows "verified. Nothing is unlocked in this spike."
3. Click the button again and **cancel** (Esc or Cancel). The screen must say "cancelled" and the button must work again.
4. Optional: remove or turn off Hello, press the button; it should say "unavailable" (or "failed" with a reason), without a crash.
5. Open startup.log and copy the lines with `device` and `time-to-prompt`:
   `device prompt requested`, `device prompt shown (...) N ms after press`, `time-to-prompt N ms`, `device answered (verified|cancelled|unavailable|failed)`.
   Windows: if `shown` says "window not detected", the prompt time is only approximate; use your own count.

## 4. Typing test (accents, dead keys, IME)

On the lock screen the field **Type here to test accents and dead keys** is shown; what you type is repeated in large letters below it.
1. Type: `é ü ñ ç ß ã` (copy-paste is not the test; type them). Expected: the same characters, in the field and in the large line.
2. Dead keys: switch to a keyboard with dead keys (Windows: US-International; Mac: any, Option+E). Type `^` then `e` = ê, `~` then `n` = ñ, `'` then `e` = é
   (Mac: Option+E then e = é, Option+N then n = ñ). Expected: nothing visible wrong while pending, one correct character at the end.
3. Windows IME (only if you use one, e.g. Japanese, Chinese, Korean): Win+Space to switch, type a word. Expected: underlined text while composing, the
   candidate list next to the cursor (not in a far corner), the final text in both places.

## 5. Screen reader quick check

Start `start-ui` (lock-hello screen), then switch the reader on: **Narrator** Win+Ctrl+Enter (off again: same keys); **VoiceOver** Cmd+F5.
Press Tab (VoiceOver: Ctrl+Option+Right arrow) to move and listen. Expected to hear:
- Title "Unlock Kasboek"; the hint text; button "Unlock with Windows Hello" (Mac: "Touch ID"); "Forgot password?" and "Erase data" (as buttons).
- Run `start-ui --screen lock-password`: edit field "Password", button "Unlock", button for show/hide password.
- Run `start-ui --screen overview`: each sidebar item (Overview, Transactions, Budgets, ...) read by name and as a button; the main amounts read as text.
Known weak spots we want to see: icons read as "image" with no name, the Hello button skipped by Tab, a missing name on an item.
Note for each of the 3 screens: what was read, what was missing or wrong.

## 6. Look: compare with the real Kasboek

Open the real Kasboek next to the spike (same theme) and look at the lock screen and the overview.
- Light and dark: `start-ui --theme light`, then `--theme dark` (the real app: Settings > Appearance).
- 100% and 200%: `start-ui --scale 1`, then `--scale 2`. Text must stay sharp and the card keep its proportions.
- German: `start-ui --lang de`, also `--screen overview`. Nothing may be cut off or overlap; the long button text must fit.
Differences in the thin edges of letters are expected (different text drawing). Report: wrong colours, wrong spacing, a different font, cut-off or overlapping text.
Screenshots of the spike made by the build itself are in the folder `shots` (same screens, for comparing without starting anything).

## 7. Window behaviour

Resize from all four edges and corners (no black flashes, card stays centred); drag the window by its title bar; Windows: Win+Left, Win+Right, Win+Up
(snap, maximise, restore); Mac: green button. With two screens of different scale, drag it across: text must re-sharpen. Note anything odd.

## 8. Optional: your own PDF statements, only on this computer

Download `kasboek-spike-pdf-<system>-<chip>` the same way and unpack it. Windows: drag a folder with your PDFs onto `check-pdfs.cmd`.
Mac: `./check-pdfs.sh /path/to/folder` (same Terminal steps as in 1.3). It prints one line of numbers per file, never any text, and writes nothing.
Reply with the last line ("N file(s): ... ok, ... to look at") and the lines marked CHECK or ERROR (rename private file names). Details: `PDF-README.txt`.

## Reply table (copy it, fill what you tested)

| # | Check | Win x64 | Win ARM64 | Mac arm64 | Mac Intel | Notes |
|---|---|---|---|---|---|---|
| 2 | First frame, first run after download (ms) | | | | | |
| 2 | First frame, cold after restart (ms) | | | | | |
| 2 | First frame, warm (3 numbers, ms) | | | | | |
| 3 | Hello / Touch ID prompt time (ms, `time-to-prompt`) | | | | | |
| 3 | Correct answer shows "verified" | | | | | |
| 3 | Cancel shows "cancelled", button works again | | | | | |
| 4 | é ü ñ ç ß ã typed correctly | | | | | |
| 4 | Dead keys (^e, ~n) correct | | | | | |
| 4 | IME composition (if used) | | | | | |
| 5 | Narrator / VoiceOver: lock screen read | | | | | |
| 5 | Narrator / VoiceOver: overview nav read | | | | | |
| 6 | Looks like the real app: light / dark | | | | | |
| 6 | 100% and 200% sharp, German fits | | | | | |
| 7 | Resize, drag, snap, two screens | | | | | |
| 8 | PDF check: last line | | | | | |
