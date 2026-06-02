# Moises Visual Metronome

A Tampermonkey userscript that adds a **visual beat indicator** to [Moises Studio](https://studio.moises.ai) - synced directly to the app's internal audio engine, not guesswork.

Built for drummers who practice with stem-separated tracks and want a peripheral visual click instead of (or alongside) the audio metronome.

![beat bar preview](https://img.shields.io/badge/status-working-00ffc8?style=flat-square) ![platform](https://img.shields.io/badge/platform-Chrome%20%2F%20Android-784ba0?style=flat-square) ![license](https://img.shields.io/badge/license-MIT-ff3cac?style=flat-square)

---

## How it works

Moises Studio runs its audio engine inside a sandboxed iframe (`studio1.moises.ai`) using the [Superpowered](https://superpowered.com/) WebAssembly SDK. The script:

1. Hooks `AudioNode.prototype.connect` inside the iframe to intercept the `MultitrackWithFallback` AudioWorklet node
2. Listens to the existing `getStatus` port messages that Moises already polls (~10Hz), extracting `positionMs` and playback state
3. Fetches the pre-rendered `metronome.m4a` audio file and runs onset detection on the PCM data to extract exact beat timestamps
4. Uses a **predictive scheduler** (`setTimeout` chained to the next beat timestamp) rather than reacting to position polls - eliminating timing jitter entirely
5. Fires a flash animation on the bar at the bottom of the screen (and optionally a fullscreen overlay) at each beat

Because beats are scheduled ahead of time based on the audio file's actual click positions, timing is consistent regardless of network or polling latency.

---

## Features

- **Synced to the actual metronome audio** - beat timestamps extracted directly from `metronome.m4a`, not calculated from BPM
- **Zero jitter** - predictive scheduler fires within ~2ms of the audio click
- **Full-screen overlay mode** - covers the whole screen with a translucent flash, visible in peripheral vision
- **Beat 1 differentiation** - bar/overlay pulses cyan on beat 1, pink/purple on beats 2-4
- **Smooth falloff** - instant flash, 520ms ease-out decay
- **Manual BPM override** - +/- buttons and tap tempo if you want to override the detected tempo
- **Bar size control** - configurable beats per bar
- **SHIFT button** - nudges beat 1 alignment by one beat if the bar phase is off
- **Draggable widget** - position it anywhere on screen
- **Works on Android** - tested in Kiwi Browser with Tampermonkey

---

## Installation

### Desktop (Chrome / Firefox)

1. Install [Tampermonkey](https://www.tampermonkey.net/)
2. Click **Create new script**
3. Paste the contents of [`mvc.user.js`](./mvc.user.js)
4. Save (`Ctrl+S`)

Or visit the raw file URL directly in your browser - Tampermonkey will prompt to install automatically:

```
https://raw.githubusercontent.com/Sec-Dan/moises-visual-click/main/mvc.user.js
```

### Android tablet

You need a Chromium-based Android browser that supports Chrome extensions. [Lemur Browser](https://play.google.com/store/apps/details?id=com.lemurbrowser.exts) is a current working option - others exist, just avoid anything listed as archived or unmaintained.

1. Install your chosen Chromium+extensions Android browser
2. Install [Tampermonkey](https://chrome.google.com/webstore/detail/tampermonkey/dhdgffkkebhmkfjojejmpbldmpobfkfo) from the Chrome Web Store within that browser
3. Visit the raw script URL above - Tampermonkey auto-detects `.user.js` files and prompts to install
4. In the browser's extension settings, enable **Allow access to file URLs** for Tampermonkey

---

## Usage

1. Open [studio.moises.ai](https://studio.moises.ai) and load a track
2. The widget appears bottom-right - it will show **"analysing…"** while it fetches and processes the metronome audio
3. Once analysis is complete the detected BPM is displayed and the visual click starts automatically when you hit play
4. Hit **FULLSCREEN** to toggle the full-screen overlay - useful when the tablet is off to the side

### Widget controls

| Control | Description |
|---|---|
| **− / +** | Override BPM manually (first click seeds from detected value) |
| **TAP** | Tap tempo to set BPM manually |
| **Bar − / +** | Beats per bar (default 4) |
| **SHIFT** | Offset beat 1 by one position if bar alignment is wrong |
| **FULLSCREEN** | Toggle full-screen flash overlay |

---

## Customisation

All visual values are in the CSS block at the top of the parent-side code. Useful things to tweak:

```css
/* Bar height */
#mvc-bar { height: 52px; }

/* Fullscreen overlay brightness - increase for strong peripheral visibility */
#mvc-fs.c1 { background: rgba(0,255,200, .52); }   /* beat 1 */
#mvc-fs.cx { background: rgba(180,50,200, .44); }   /* other beats */

/* Flash decay time */
@keyframes mvc-out { from{opacity:1} to{opacity:0} }
#mvc-bar.go, #mvc-fs.go { animation: mvc-out 520ms ease-out forwards; }
```

---

## Technical notes

### Why not hook BPM from the Moises UI?

The BPM display in the Moises interface is a React state value that's difficult to reliably scrape across page updates. More importantly, Moises pre-renders the metronome audio at the exact tempo with any swing, feel, or tempo automation already baked in - so reading the audio directly is more accurate than any BPM number would be.

### Why `studio1.moises.ai`?

Moises embeds its player in a cross-origin iframe at `studio1.moises.ai`. The audio engine, Superpowered WASM, and all AudioWorklet processing live in that frame. The script matches both origins and uses `postMessage` to bridge data from the iframe to the parent shell where the visual overlay lives.

### Why a predictive scheduler instead of reacting to position updates?

Moises polls `getStatus` at roughly 10Hz (~100ms intervals). Reacting on each poll means the flash fires somewhere between 0-100ms after the actual beat, and that error varies in a pattern that sounds/looks like swing. Scheduling `setTimeout(delay)` for the exact moment of the next beat (calculated from the current estimated position and wall clock) fires within ~2ms regardless of poll rate.

---

## Compatibility

| Browser | Status |
|---|---|
| Chrome (desktop) | Working |
| Firefox + Tampermonkey | Should work, untested |
| Chromium-based Android browsers with extension support | Working |
| Safari | Not supported (no Tampermonkey) |

Any Android browser that supports Chrome extensions and runs a modern Chromium engine should work. Test with a small track first to confirm the analysis step completes on your device.

Tested against Moises Studio as of June 2025. Moises could update their frontend at any time which may break the iframe hook - if it stops working, the most likely culprit is a changed AudioWorklet node name or iframe origin.

---

## Licence

MIT - do whatever you want with it.

---

*Built by [dansec](https://dansec.red)*