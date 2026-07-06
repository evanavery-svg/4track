# Four Track

A minimalist four-track recorder for demos, built as an installable PWA.
White, crumpled-paper aesthetic; works on phones and desktops; no
dependencies, no build step — just static files.

## Features

- **Four tracks** with record, mute, volume, pan, per-track waveforms and
  editable names.
- **Overdubbing** — recording plays the other tracks in sync, and takes are
  automatically aligned (recorder spin-up and output latency are trimmed;
  fine-tune in Settings if your device needs a nudge).
- **Count-in** — one bar of clicks before each take.
- **Metronome** with tap tempo and hold-to-repeat BPM steppers. Clicks never
  end up in the mix.
- **Auto-save** — everything is persisted to IndexedDB as you go, so your
  demo survives a reload or a dead battery.
- **Undo per track** — the previous take is kept; tap ↩︎ to swap back.
- **WAV export** — mixes all unmuted tracks offline (with automatic
  peak-safe normalization) and downloads a 16-bit stereo WAV.
- **Smart touches** — click/drag any waveform to scrub, screen wake-lock
  while rolling, clip warning on hot takes, offline-capable via service
  worker.
- **Keyboard shortcuts** — `Space` play/stop · `1`–`4` record a track ·
  `M` metronome · `L` loop · `E` export · `Enter` return to start ·
  `Esc` stop.

## Running

Serve the folder over HTTPS (or localhost) — the microphone API requires a
secure context:

```sh
python3 -m http.server 8000
# open http://localhost:8000
```

Install it from the browser's "Add to Home Screen" / "Install" prompt to get
the standalone app experience.

> Tip: use headphones when overdubbing, otherwise the mic will pick up the
> other tracks and the metronome.

## Development notes

- `app.js` — all app logic (Web Audio playback/mixing, MediaRecorder
  capture, metronome scheduler, IndexedDB persistence, WAV encoder).
- `style.css` — the crumpled-paper look. The texture is an inline SVG
  (`feTurbulence` + `feDiffuseLighting`) so there are no image assets.
- `tools/make_icons.py` — regenerates the PNG icons from the same artwork
  as `icons/icon.svg` (stdlib-only PNG encoder): `python3 tools/make_icons.py`.
- `sw.js` — cache-first service worker; bump `CACHE` when shipping changes.
