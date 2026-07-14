# 4track

**v0.18 · © Avery**

A minimalist four-track recorder for demos, built as an installable PWA.
Crumpled-paper aesthetic, guaranteed single-screen layout on phones and
desktops, no dependencies, no build step — just static files.

## Recording

- **Four tracks** — tap ● to record; the armed track draws the live mic
  waveform in red while you play. Takes are stored as centered mono, with
  ~6ms de-click fades at the edges.
- **Overdubbing** — recording plays the other tracks in sync; takes are
  auto-aligned (recorder spin-up + output latency trimmed, fine-tune in
  Settings). Punch in from wherever the playhead sits.
- **Mic sensitivity** (25–400%) for quiet inputs; live level meter.
- **Input monitor** — hear yourself (headphones!) via the MONITOR pill in
  the header; stays on through recording and can be toggled mid-take.
- **Count-in** — one bar of clicks before each take; the metronome button
  is the master switch and silences the click even mid-recording.

## Mixing & tracks

Tap a track to open its options sheet: rename, volume (to 200%), pan,
tone (dark↔bright tilt EQ), solo, mute, undo take, clear, and a
zoomable/scrollable detail waveform. Drag horizontally on a track to
scrub the timeline.

## Sound

- **Lo-Fi** — tape-crush over the whole mix (bandpass, saturation,
  bitcrush, wow/flutter, gentle hiss) with Warm / Cassette / Radio /
  Trashed presets and an intensity slider. Applied identically to
  playback and export.
- **Speaker Boost** — a loudness maximizer (drive → limiter → makeup →
  soft-clip) that makes playback dramatically louder on tiny phone
  speakers. Playback only; exports stay clean. Metronome and monitor are
  routed through it too, so nothing sounds mysteriously quiet.

## Tools

- **Tuner** — chromatic autocorrelation tuner off the mic input (note,
  octave, cents needle; green within ±5¢).
- **Metronome** — tap tempo, hold-to-repeat BPM, beats-per-bar 2–12,
  subdivisions (¼ ⅛ ⅛T 1/16), three accent levels.
- **Loop** — whole song, or an A/B region set at the playhead (shown as a
  band across the waveforms).
- **Notes** — a free-text pad per project (lyrics, chords, tunings),
  saved with the project and included in backups.

## Projects

Unlimited projects (folder icon): each keeps its own tracks, settings,
loop region, and notes, auto-saved to IndexedDB as you go. Two-tap
delete. **Back up / Import** moves a whole project between devices as a
portable `.4track.json` (settings + 16-bit WAV per track).

## Export & system

- **WAV export** — offline mixdown of unmuted tracks (peak-safe
  normalization), delivered through the native share sheet (Messages,
  AirDrop, Files…) or saved as a download.
- **Media Session** — lock-screen / headphone-remote play, pause, seek,
  with position state.
- **Always fresh** — network-first service worker plus an independent
  version.json check that clears a wedged worker and reloads (never
  mid-take). Fully offline-capable.
- **Themes** — eight paper themes (incl. dark Graphite and Midnight), six
  accents, texture-intensity slider.
- **Safety** — screen wake-lock while rolling, close-tab warning during a
  take, keyboard shortcuts guarded behind sheets, reduced-motion support.
- **Shortcuts** — `Space` play/stop · `1`–`4` record track · `M`
  metronome · `L` loop · `E` export · `Enter` return to start · `Esc`
  stop / close sheets.

## Running

Serve the folder over HTTPS (or localhost) — the microphone API requires
a secure context:

```sh
python3 -m http.server 8000
# open http://localhost:8000
```

Install from the browser's "Add to Home Screen" / "Install" prompt.

> Tip: use headphones when overdubbing or monitoring, otherwise the mic
> picks up the other tracks and the metronome.

## Development notes

- `app.js` — all logic: Web Audio graph (tracks → tone → bus → [Lo-Fi] →
  master → [Speaker Boost] → out), MediaRecorder capture, metronome
  scheduler, tuner, projects/IndexedDB, themes, WAV encoder.
- `style.css` — crumpled-paper look (inline SVG turbulence texture) and
  the `:root[data-theme=…]` theme variable sets.
- `sw.js` — network-first service worker. When releasing, bump `VERSION`
  in `sw.js`, `APP_VERSION` in `app.js`, and `version.json` together.
- `tools/make_icons.py` — regenerates PNG icons (stdlib-only PNG encoder).
