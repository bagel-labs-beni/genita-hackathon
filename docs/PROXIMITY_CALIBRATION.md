# Proximity handoff ("징"): calibrate, then flip on

Bring the iPhone (in a live call) close to the Mac and the call moves by itself (#327, PROTOCOL.md "Proximity").
Shipped **off**. Server side needs no flag (it only answers `proximity.*` messages). Both apps read the same switch.

## The switches

| what | where | effect |
|---|---|---|
| both apps, no build | server app-config JSON (`GENITA_APP_CONFIG_FILE` on the instance) `flags.proximityHandoff: true` | iPhone arms a BLE token in a live call, Mac scans. Re-read by the server within 5 s; apps fetch it at launch / on activate. Relaunch both apps. |
| one Mac, override | `defaults write ai.thebeni.genita.mac genita.proximity.handoff -bool YES` (or `NO`) | wins over app-config on that Mac |
| one Mac, launch env | `GENITA_PROXIMITY_HANDOFF=1` | wins over both (dev runs) |
| off again | app-config `false` + `defaults delete ai.thebeni.genita.mac genita.proximity.handoff` | no prompt, no scan, no toast; Move to Mac unchanged |

## Thresholds (Mac only, no build)

Defaults: close = smoothed RSSI ≥ **−45 dBm** held **0.5 s** (≥ 3 readings, median of 3), re-arm below **−55 dBm**, 10 s cooldown.

```sh
defaults write ai.thebeni.genita.mac genita.proximity.enterRSSI -int -50   # range −90…−20
defaults write ai.thebeni.genita.mac genita.proximity.exitRSSI  -int -60   # range −100…−25, always ≤ enter − 1
defaults write ai.thebeni.genita.mac genita.proximity.holdSeconds -float 0.5  # 0.2…3
```
Relaunch the Mac app after a change (read at launch).

## Calibration (one Mac + one iPhone, ~10 min)

Needs: server with #327 (prod has it), iPhone TestFlight + Mac DMG from the same build, both signed in to the **same** account, Bluetooth on.

1. Flag on (table above) on the Mac by `defaults`, and app-config for the iPhone. Relaunch both.
2. On the Mac: `log stream --predicate 'subsystem == "ai.thebeni.genita" AND category == "proximity"' --level debug`
3. Start a call on the iPhone (Bluetooth prompt appears now on both, not at launch). The Mac log shows `proximity scanning`.
4. Read the smoothed level (`proximity rssi … smoothed N`) at four spots, ~5 s each, phone screen up:
   - **A** on the palm rest / touching the Mac edge where the demo will happen
   - **B** 10 cm away  ·  **C** 30 cm away (normal desk distance)  ·  **D** in a pocket / behind the laptop
5. Pick `enterRSSI` = (A's typical reading) − 3 dB, and check it is **above** B and C by ≥ 5 dB. Pick `exitRSSI` ≤ C. Typical MacBook: A ≈ −35…−50, C ≈ −60…−75. If A and C are within 8 dB of each other, the demo spot is bad (antenna side differs by model): try the other side of the keyboard.
6. Write the values with `defaults` (above), relaunch the Mac app.
7. Pass test: 10 approaches to spot A → ≥ 8/10 move within 2 s (log `held close, reporting` → `result true ok`); 5 slow walks past at 30 cm → 0 moves; after a move, tap Continue here with the phone still on the Mac → it stays on the iPhone.
8. Record the four readings + chosen values here (table below) and in the PR/QA note.

| date | Mac model | iPhone | A | B | C | D | enter / exit | 10-try result |
|---|---|---|---|---|---|---|---|---|
| | | | | | | | | |

If the log shows readings but `token no`, the Mac isn't receiving the advertised local name (scan response); report it (needs a GATT read fallback).
Full device QA list (permission timing, strangers, locked screens, fallback): PR #327 "Device QA" comment.
