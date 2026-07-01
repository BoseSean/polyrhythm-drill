# Polyrhythm Drill · 复合节奏练习器

**▶ Live demo: https://bosesean.github.io/polyrhythm-drill/**

A tiny, dependency‑free web app for practising **polyrhythms** — 2:3, 3:4, 4:7, 9:11, 7:11, or any `a:b` you like. Tap two keys (one per hand), see exactly how tight you are on a scrolling timeline, and play your performance back so your ears can be the judge.

Everything runs **100% in the browser** with vanilla JS + the Web Audio API. No server, no tracking, no build step.

## ✨ Features

- **Key mapping** — bind any two keyboard keys to your left/right hand.
- **Any ratio** — set `L : R` directly or pick from presets (2:3 … 9:11). Both hands start together each cycle.
- **Real‑time feedback** — every tap is timestamped and scored against the nearest reference beat, with the signed offset (**Off**, in ms) shown live. Green = tight, yellow = close, red = off.
- **Scrolling timeline** — reference ticks flow toward a **Now** line so you can *see* where to land; your taps drop onto two lanes with a connector back to their target.
- **Accuracy scatter** — every tap folded into a single cycle so you can spot whether you rush or drag.
- **Playback** — hear your taps back with **distinct tones per hand** (left = warm C5 triangle, right = reedy G5 square). Or play the perfect **reference** pattern to model it.

### Two practice modes

| Mode | What it does |
|------|--------------|
| **Fixed Tempo** | Practise at a set BPM with an optional **metronome** (downbeat click) and an optional **reference pattern** guide. Timeline shows the target ticks. |
| **Freestyle** | Just tap for a while, hit **Stop**, and the app **reverse‑engineers** your tempo (bpm per hand) and your **ratio** (e.g. "≈ 3:4, cleanly matched") from your inter‑tap timing. One click loads it back into Fixed mode. |

## 🎹 How to use

1. Open **`index.html`** (double‑click, or serve it — see below).
2. Pick a **ratio** and a **tempo** (choose whether BPM counts the whole cycle or one hand).
3. (Optional) rebind your two keys — defaults are **F** (left) and **J** (right).
4. Press **Start** (or hit **Space**) and tap along with the reference ticks.
5. Watch **Avg off / In‑time %** climb, then **Playback my taps** to listen.

> **Tip:** turn on *Play reference pattern* first to internalise the sound, then switch it off and rely on just the metronome.

## 🏃 Running locally

It's a static site, so any of these work:

```bash
# simplest — just open the file
#   (double-click index.html)

# or serve it (better: consistent AudioContext behaviour across browsers)
python -m http.server 8000
#   → http://localhost:8000
```

## 🌐 GitHub Pages

The live version is deployed at:

**https://bosesean.github.io/polyrhythm-drill/**

(served from the `main` branch root — pushing to `main` redeploys it.)

## 🧠 How the timing works

- A **cycle** repeats forever. It holds `a` evenly‑spaced left beats and `b` evenly‑spaced right beats, both starting on the downbeat.
- Cycle length depends on your BPM and what it counts:
  - *per cycle* → `cycle = 60 / bpm`
  - *left hand* → `cycle = a × 60 / bpm`
  - *right hand* → `cycle = b × 60 / bpm`
- Each tap's **Off** = `tapTime − nearestReferenceTime` (negative = early, positive = late).
- Metronome and reference sounds are scheduled on the **AudioContext clock** with a lookahead scheduler for rock‑solid timing; taps are captured with `performance.now()`.

## 📁 Structure

```
polyrhythm-drill/
├── index.html   # markup
├── styles.css   # dark theme
├── app.js       # all logic: audio, scheduling, canvas, analysis
└── README.md
```

No frameworks. Hack away.

---

Made for drummers, pianists, and anyone fighting with 4‑over‑3. 🥁
