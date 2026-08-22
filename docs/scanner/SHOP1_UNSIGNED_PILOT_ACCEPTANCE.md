# Shop-1 Unsigned Pilot — Install & Acceptance Runbook

**Package under test**

| | |
|---|---|
| Version | `1.2.1` |
| Source commit | `93e16d65` |
| Bundle SHA-256 | `357f5e6c8d5c3716efaff6dea8d642484c85588ac24c906ac79863e0f9fcdfd8` |
| Bundle id | `com.mintvault.scanner` |
| Signing | **UNSIGNED** — TEMPORARY CONTROLLED PILOT, not general distribution |
| Environment | Fixed PRODUCTION (`https://mintvaultuk.com`) |

Run this on the **designated Shop-1 Mac only**. Do not run it on a Mac that already has a
working MintVault station — the script below refuses to, but check anyway.

---

## 0. Baseline (record before touching anything)

On the Shop-1 Mac:

```bash
system_profiler SPHardwareDataType | grep -E 'Model Name|Model Identifier|Chip'
sw_vers
ls -la "$HOME/Library/Application Support/MintVaultScanner" 2>/dev/null || echo "no existing station identity (expected for a fresh Mac)"
```

Expected on a fresh Shop-1 Mac: **no such directory**. If it exists, stop and decide
deliberately — this is not a fresh Mac.

Verify you received the right bytes:

```bash
shasum -a 256 -c <<< "357f5e6c8d5c3716efaff6dea8d642484c85588ac24c906ac79863e0f9fcdfd8  MintVault Scanner.app.zip"
```

(compare against whatever archive form you transferred; the value above is the **.app bundle
digest** recorded in the manifest, so also re-run `node scripts/verify-package.js` if you
rebuilt rather than copied.)

---

## 1. One-time install (unsigned app, Gatekeeper honoured)

Copy `MintVault Scanner.app` into `/Applications`.

Because the app is unsigned and arrived from another machine, macOS attaches a quarantine
flag and will refuse the first launch. The **supported one-time approval** is:

1. Double-click **MintVault Scanner** in `/Applications`. macOS shows
   *"Apple could not verify … is free of malware."* Click **Done**.
2. Open **System Settings → Privacy & Security**.
3. Scroll to the **Security** section. You will see
   *"MintVault Scanner was blocked to protect your Mac."* Click **Open Anyway**.
4. Authenticate with Touch ID or the Mac's admin password.
5. Double-click the app again. Click **Open** in the final confirmation.

That is the whole procedure. It is per-app and one-time.

**Do NOT** run `sudo spctl --master-disable`, and do NOT blanket-remove quarantine
attributes across folders. Gatekeeper stays on. If you want the app's quarantine flag
cleared explicitly rather than via the GUI, the narrow, single-app form is:

```bash
xattr -d com.apple.quarantine "/Applications/MintVault Scanner.app"
```

Use the GUI path above by preference — it is the documented Apple flow and leaves an audit
trail in Privacy & Security.

Also grant, when macOS asks:

- **Local Network** (talks to the Canon over USB/IP bridge)
- **Files and Folders** / Full Disk Access only if the scan folder prompts for it

Record every prompt you actually saw in the results table.

**After install, launch only from the Finder/Dock icon.** No Terminal is needed for daily
use. The acceptance script below uses Terminal, but that is the *test harness*, not
day-to-day operation.

---

## 2. First launch and enrolment

1. Launch from the Dock/Finder icon.
2. Sign in as the Shop-1 Partner Owner.
3. Complete MFA.
4. Confirm the Main location is shown.
5. The app requests station enrolment.
6. In Super Admin → Fleet, approve the station.
7. Confirm the Scanner reports **READY**.

Record: station code, station id, Partner name, location name.

---

## 3. Automated persistence acceptance

`scripts/scanner-app/scripts/shop1-pilot-acceptance.js` performs the repetitive parts and
proves the identity never changes. Run it from a Terminal on the Shop-1 Mac **after**
enrolment is approved:

```bash
cd /Applications
node "/path/to/repo/scripts/scanner-app/scripts/shop1-pilot-acceptance.js" --launches 20 --service-restarts 10
```

It will:

- refuse to run if no station identity exists yet (enrol first),
- record the station identity fingerprint at the start,
- quit and relaunch the app N times, re-reading the identity each time,
- restart the native scanner bridge N times,
- fail loudly if the station code, installation id or public key ever changes,
- write `shop1-pilot-acceptance-report.json` next to the station identity.

### Mac restarts (manual — 5 cycles)

A reboot cannot be scripted end-to-end. For each of the 5 cycles:

```bash
sudo shutdown -r now      # or use the Apple menu
```

After each reboot: launch from the icon, sign in if prompted, then run

```bash
node ".../shop1-pilot-acceptance.js" --verify-only
```

which re-reads the identity and appends a `reboot` result to the same report.

### Network recovery

Turn Wi-Fi off in the menu bar. Confirm the app shows a clear offline state and that no
card, job or credit changes. Turn Wi-Fi back on and confirm it reconnects. Then:

```bash
node ".../shop1-pilot-acceptance.js" --verify-only --label network-recovery
```

### Sign out / sign in

Sign out in the app, sign back in, confirm the station is still approved and no
re-enrolment is requested. Then run `--verify-only --label signout-signin`.

---

## 4. Super Admin confirmation (the decisive check)

In Super Admin → Fleet, filter to the Shop-1 Partner. Confirm:

- exactly **one** station row,
- status **ACTIVE**,
- station code identical to the one recorded at step 2.

Any second station row is a FAIL and must be investigated before the pilot proceeds.

---

## 5. Results

Fill in and return:

```
MAC MODEL / MACOS:
PACKAGE INSTALL:            PASS / FAIL
GATEKEEPER STEPS SEEN:      <list>
NORMAL ICON LAUNCH:         PASS / FAIL
NO TERMINAL DAILY USE:      PASS / FAIL
PARTNER LOGIN:              PASS / FAIL
MFA:                        PASS / FAIL
STATION ENROLMENT:          PASS / FAIL
STATION APPROVAL:           PASS / FAIL
STATION CODE:               <code>
20X APP LAUNCH:             PASS / FAIL
10X SERVICE RESTART:        PASS / FAIL
5X MAC RESTART:             PASS / FAIL
NETWORK RECOVERY:           PASS / FAIL
SIGN OUT / SIGN IN:         PASS / FAIL
STATION IDENTITY:           PRESERVED / FAIL
DUPLICATE STATIONS:         ZERO / FAIL
```

---

## Known upgrade caveat — read before the signed build lands

The station identity is encrypted with Electron `safeStorage`, which on macOS is backed by
the login Keychain and keyed to the **app's code signature**. Going from this unsigned pilot
build to a signed/notarised build changes that signature.

`readIdentity()` throws on a decrypt failure and `loadOrCreateIdentity()` only mints a fresh
identity when the file is **absent** — so a signed build that cannot decrypt the pilot's
envelope will **fail loudly and cannot silently create a second station**. That is the
correct, safe failure.

But it does mean the first launch of the signed build may hard-fail until the Keychain
prompt is granted. Plan for that: when the signed build arrives, launch it once with the
owner present, expect a Keychain access prompt, and click **Always Allow**. Do not delete
the station or re-enrol without checking with MintVault first.
