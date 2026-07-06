'use strict';

/* Crumple — a minimalist 4-track recorder.
   Web Audio + MediaRecorder, no dependencies. */

const APP_VERSION = '0.4';
const NUM_TRACKS = 4;
const BEATS_PER_BAR = 4;

const THEMES = {
  paper:    { label: 'Paper',    sw: ['#f2f1ee', '#ffffff', '#1c1c1e'] },
  kraft:    { label: 'Kraft',    sw: ['#e7dcc7', '#f8f2e4', '#3b3226'] },
  blush:    { label: 'Blush',    sw: ['#f3e3e1', '#fcf5f4', '#40312f'] },
  mint:     { label: 'Mint',     sw: ['#e2ece4', '#f5faf6', '#26352b'] },
  butter:   { label: 'Butter',   sw: ['#f2ead0', '#fbf7e9', '#3d3620'] },
  slate:    { label: 'Slate',    sw: ['#e4e8ee', '#f5f7fa', '#232a33'] },
  graphite: { label: 'Graphite', sw: ['#161618', '#232326', '#f0f0f2'] },
  midnight: { label: 'Midnight', sw: ['#10161f', '#1b2430', '#edf2f9'] },
};

const ACCENTS = {
  blue: '#007aff', teal: '#30b0c7', green: '#34c759',
  orange: '#ff9500', pink: '#ff2d55', purple: '#af52de',
};

const $ = (sel, el = document) => el.querySelector(sel);
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

function fmtTime(sec, frac = false) {
  sec = Math.max(0, sec);
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  const d = Math.floor((sec % 1) * 10);
  return frac ? `${m}:${String(s).padStart(2, '0')}.${d}` : `${m}:${String(s).padStart(2, '0')}`;
}

/* ---------------- WAV encoding ---------------- */

function encodeWav(channelData, sampleRate, float32 = false) {
  const numCh = channelData.length;
  const len = channelData[0].length;
  const bytesPerSample = float32 ? 4 : 2;
  const blockAlign = numCh * bytesPerSample;
  const dataSize = len * blockAlign;
  const buf = new ArrayBuffer(44 + dataSize);
  const dv = new DataView(buf);
  const wstr = (off, s) => { for (let i = 0; i < s.length; i++) dv.setUint8(off + i, s.charCodeAt(i)); };

  wstr(0, 'RIFF'); dv.setUint32(4, 36 + dataSize, true); wstr(8, 'WAVE');
  wstr(12, 'fmt '); dv.setUint32(16, 16, true);
  dv.setUint16(20, float32 ? 3 : 1, true);          // 3 = IEEE float, 1 = PCM
  dv.setUint16(22, numCh, true);
  dv.setUint32(24, sampleRate, true);
  dv.setUint32(28, sampleRate * blockAlign, true);
  dv.setUint16(32, blockAlign, true);
  dv.setUint16(34, bytesPerSample * 8, true);
  wstr(36, 'data'); dv.setUint32(40, dataSize, true);

  let off = 44;
  for (let i = 0; i < len; i++) {
    for (let ch = 0; ch < numCh; ch++) {
      const v = channelData[ch][i];
      if (float32) { dv.setFloat32(off, v, true); }
      else {
        const s = clamp(v, -1, 1);
        dv.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7fff, true);
      }
      off += bytesPerSample;
    }
  }
  return buf;
}

function bufferToWav(audioBuffer, float32 = false) {
  const chans = [];
  for (let c = 0; c < audioBuffer.numberOfChannels; c++) chans.push(audioBuffer.getChannelData(c));
  return encodeWav(chans, audioBuffer.sampleRate, float32);
}

/* ---------------- tiny IndexedDB key-value store ---------------- */

const idb = {
  _db: null,
  open() {
    if (this._db) return Promise.resolve(this._db);
    return new Promise((res, rej) => {
      const req = indexedDB.open('fourtrack', 1);
      req.onupgradeneeded = () => req.result.createObjectStore('kv');
      req.onsuccess = () => { this._db = req.result; res(this._db); };
      req.onerror = () => rej(req.error);
    });
  },
  async get(key) {
    const db = await this.open();
    return new Promise((res, rej) => {
      const req = db.transaction('kv').objectStore('kv').get(key);
      req.onsuccess = () => res(req.result);
      req.onerror = () => rej(req.error);
    });
  },
  async set(key, val) {
    const db = await this.open();
    return new Promise((res, rej) => {
      const tx = db.transaction('kv', 'readwrite');
      tx.objectStore('kv').put(val, key);
      tx.oncomplete = res;
      tx.onerror = () => rej(tx.error);
    });
  },
  async del(key) {
    const db = await this.open();
    return new Promise((res, rej) => {
      const tx = db.transaction('kv', 'readwrite');
      tx.objectStore('kv').delete(key);
      tx.oncomplete = res;
      tx.onerror = () => rej(tx.error);
    });
  },
};

/* ---------------- app state ---------------- */

const app = {
  ctx: null,
  master: null,
  micStream: null,
  micAnalyser: null,
  recorder: null,
  recTrack: -1,
  recChunks: [],
  recT0: 0,             // ctx time where the timeline (startPos) begins for this take
  recStartCtx: 0,       // ctx time when MediaRecorder actually started
  recStartPos: 0,       // timeline position the take is punched in at
  recDiscard: false,

  state: 'idle',        // idle | playing | recording
  pos: 0,               // timeline position in seconds
  playStartCtx: 0,
  playStartPos: 0,
  sources: [],

  bpm: 120,
  loop: false,
  met: false,
  metRec: true,
  metVol: 0.6,
  countIn: true,
  latencyMs: 0,
  nextBeat: 0,
  schedTimer: null,

  projectId: null,
  projectsMeta: [],     // [{ id, name, updated, length, bpm }]
  prefs: { theme: 'paper', accent: 'blue', texture: 1, lastProject: null },

  tracks: [],           // { buffer, prevBuffer, name, volume, pan, muted, gainNode, panNode, ui:{} }
  sheetTrack: -1,
  wakeLock: null,
  taps: [],
};

const songLength = () =>
  app.tracks.reduce((m, t) => Math.max(m, t.buffer ? t.buffer.duration : 0), 0);

function ensureCtx() {
  if (!app.ctx) {
    app.ctx = new (window.AudioContext || window.webkitAudioContext)({ latencyHint: 'interactive' });
    app.master = app.ctx.createGain();
    app.master.connect(app.ctx.destination);
    for (const t of app.tracks) {
      t.gainNode = app.ctx.createGain();
      t.panNode = app.ctx.createStereoPanner ? app.ctx.createStereoPanner() : null;
      if (t.panNode) { t.gainNode.connect(t.panNode); t.panNode.connect(app.master); }
      else t.gainNode.connect(app.master);
      applyTrackGain(t);
    }
  }
  if (app.ctx.state === 'suspended') app.ctx.resume();
  return app.ctx;
}

function applyTrackGain(t) {
  if (!t.gainNode) return;
  t.gainNode.gain.setTargetAtTime(t.muted ? 0 : t.volume, app.ctx.currentTime, 0.015);
  if (t.panNode) t.panNode.pan.setTargetAtTime(t.pan, app.ctx.currentTime, 0.015);
}

/* ---------------- transport ---------------- */

function stopSources() {
  for (const s of app.sources) { try { s.stop(); } catch (_) {} }
  app.sources = [];
}

function startSources(fromPos, atCtxTime, exceptTrack = -1) {
  stopSources();
  for (let i = 0; i < NUM_TRACKS; i++) {
    const t = app.tracks[i];
    if (i === exceptTrack || !t.buffer || t.buffer.duration <= fromPos) continue;
    const src = app.ctx.createBufferSource();
    src.buffer = t.buffer;
    src.connect(t.gainNode);
    src.start(atCtxTime, fromPos);
    app.sources.push(src);
  }
}

function play() {
  if (app.state !== 'idle') return;
  ensureCtx();
  if (songLength() === 0) { toast('Nothing to play yet — record a track'); return; }
  if (app.pos >= songLength() - 0.25) app.pos = 0;
  const t0 = app.ctx.currentTime + 0.08;
  startSources(app.pos, t0);
  app.playStartCtx = t0;
  app.playStartPos = app.pos;
  app.state = 'playing';
  startBeatScheduler();
  requestWakeLock();
  updateTransportUI();
}

function stopAll() {
  if (app.state === 'recording') {
    stopRecordingInternal(false);
  } else if (app.state === 'playing') {
    stopSources();
  }
  stopBeatScheduler();
  app.state = 'idle';
  releaseWakeLock();
  updateTransportUI();
}

function seek(pos) {
  if (app.state === 'recording') return;
  app.pos = clamp(pos, 0, songLength());
  if (app.state === 'playing') {
    const t0 = app.ctx.currentTime + 0.06;
    startSources(app.pos, t0);
    app.playStartCtx = t0;
    app.playStartPos = app.pos;
    app.nextBeat = Math.ceil(app.pos / secPerBeat() - 1e-6);
  }
  drawPlayheads();
  updateTimeUI();
}

/* ---------------- metronome ---------------- */

const secPerBeat = () => 60 / app.bpm;

function click(atTime, accent) {
  const ctx = app.ctx;
  const osc = ctx.createOscillator();
  const g = ctx.createGain();
  osc.frequency.value = accent ? 1568 : 1046;
  g.gain.setValueAtTime(0.0001, atTime);
  g.gain.exponentialRampToValueAtTime(app.metVol * (accent ? 0.5 : 0.32) + 0.0001, atTime + 0.002);
  g.gain.exponentialRampToValueAtTime(0.0001, atTime + 0.055);
  osc.connect(g); g.connect(ctx.destination);
  osc.start(atTime); osc.stop(atTime + 0.07);
}

function startBeatScheduler() {
  stopBeatScheduler();
  app.nextBeat = Math.ceil(app.playStartPos / secPerBeat() - 1e-6);
  app.schedTimer = setInterval(() => {
    const wantClicks = app.state === 'playing' ? app.met
      : app.state === 'recording' ? (app.metRec || app.met) : false;
    if (!wantClicks) { app.nextBeat = Math.ceil(currentPos() / secPerBeat()); return; }
    const horizon = app.ctx.currentTime + 0.14;
    while (true) {
      const beatPos = app.nextBeat * secPerBeat();
      const beatCtx = app.playStartCtx + (beatPos - app.playStartPos);
      if (beatCtx > horizon) break;
      if (beatCtx >= app.ctx.currentTime - 0.01) click(beatCtx, app.nextBeat % BEATS_PER_BAR === 0);
      app.nextBeat++;
    }
  }, 30);
}

function stopBeatScheduler() {
  if (app.schedTimer) { clearInterval(app.schedTimer); app.schedTimer = null; }
}

/* ---------------- recording ---------------- */

async function getMic() {
  if (app.micStream && app.micStream.getAudioTracks().some(t => t.readyState === 'live')) return app.micStream;
  app.micStream = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
  });
  const src = app.ctx.createMediaStreamSource(app.micStream);
  app.micAnalyser = app.ctx.createAnalyser();
  app.micAnalyser.fftSize = 1024;
  src.connect(app.micAnalyser); // analysis only — no monitoring, no feedback
  return app.micStream;
}

function pickMime() {
  const list = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4;codecs=mp4a.40.2', 'audio/mp4'];
  for (const m of list) if (window.MediaRecorder && MediaRecorder.isTypeSupported(m)) return m;
  return '';
}

async function toggleRecord(i) {
  if (app.state === 'recording') {
    const was = app.recTrack;
    stopAll();
    if (was === i) return;      // stopped this track's take
    return;                     // stopped another track; press again to arm
  }
  if (app.state === 'playing') stopAll();
  ensureCtx();

  if (!navigator.mediaDevices || !window.MediaRecorder) {
    toast('Recording is not supported in this browser'); return;
  }
  let stream;
  try { stream = await getMic(); }
  catch (_) { toast('Microphone access is needed to record'); return; }

  const mime = pickMime();
  app.recChunks = [];
  app.recorder = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
  app.recorder.ondataavailable = (e) => { if (e.data && e.data.size) app.recChunks.push(e.data); };
  app.recorder.onstop = () => finalizeTake(i);
  app.recDiscard = false;

  const started = new Promise((res) => { app.recorder.onstart = res; });
  app.recorder.start();
  await started;
  app.recStartCtx = app.ctx.currentTime;

  const countInDur = app.countIn ? BEATS_PER_BAR * secPerBeat() : 0;
  const t0 = app.ctx.currentTime + 0.18 + countInDur;
  if (app.countIn) {
    for (let b = 0; b < BEATS_PER_BAR; b++) click(t0 - countInDur + b * secPerBeat(), b === 0);
  }

  app.recStartPos = app.pos;
  app.recT0 = t0;
  app.recTrack = i;
  startSources(app.recStartPos, t0, i);
  app.playStartCtx = t0;
  app.playStartPos = app.recStartPos;
  app.state = 'recording';
  startBeatScheduler();
  requestWakeLock();
  updateTransportUI();
}

function stopRecordingInternal(discard) {
  app.recDiscard = discard;
  stopSources();
  if (app.recorder && app.recorder.state !== 'inactive') app.recorder.stop();
  app.recorder = null;
}

async function finalizeTake(i) {
  const chunks = app.recChunks;
  const trackIdx = app.recTrack;
  app.recTrack = -1;
  updateTransportUI();
  if (app.recDiscard || !chunks.length || trackIdx !== i) return;

  try {
    const blob = new Blob(chunks, { type: chunks[0].type });
    const raw = await app.ctx.decodeAudioData(await blob.arrayBuffer());

    // Smart alignment: drop the stretch captured before the timeline started
    // (recorder spin-up + count-in) plus the output latency, so overdubs land in sync.
    const outLat = app.ctx.outputLatency || app.ctx.baseLatency || 0;
    const trimSec = Math.max(0, (app.recT0 - app.recStartCtx) + outLat + app.latencyMs / 1000);
    const sr = raw.sampleRate;
    const trim = Math.min(Math.floor(trimSec * sr), raw.length);
    const keep = raw.length - trim;
    if (keep < sr * 0.12) { toast('Take was too short'); return; }

    const pad = Math.floor(app.recStartPos * sr);
    const out = app.ctx.createBuffer(raw.numberOfChannels, pad + keep, sr);
    for (let c = 0; c < raw.numberOfChannels; c++) {
      out.getChannelData(c).set(raw.getChannelData(c).subarray(trim), pad);
    }

    const t = app.tracks[trackIdx];
    t.prevBuffer = t.buffer;
    t.buffer = out;
    if (t.buffer && peakOf(out) > 0.985) toast('Take saved — heads up, the input clipped');
    else toast('Take saved');
    app.pos = app.recStartPos;   // rewind to the take's start, ready to audition
    refreshTrack(trackIdx);
    drawPlayheads();
    redrawAllWaves();
    saveTrackAudio(trackIdx);
    saveSettingsSoon();
  } catch (err) {
    console.error(err);
    toast('Could not process that take');
  }
}

function peakOf(buffer) {
  let p = 0;
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    const d = buffer.getChannelData(c);
    for (let i = 0; i < d.length; i += 32) { const a = Math.abs(d[i]); if (a > p) p = a; }
  }
  return p;
}

/* ---------------- waveforms ---------------- */

let waveInk = 'rgba(60, 58, 54, 0.72)';
function refreshWaveInk() {
  const v = getComputedStyle(document.documentElement).getPropertyValue('--wave-ink').trim();
  if (v) waveInk = v;
}

function computePeaks(buffer, buckets) {
  const d = buffer.getChannelData(0);
  const per = d.length / buckets;
  const peaks = new Float32Array(buckets);
  for (let b = 0; b < buckets; b++) {
    let max = 0;
    const start = Math.floor(b * per), end = Math.min(d.length, Math.ceil((b + 1) * per));
    const step = Math.max(1, Math.floor((end - start) / 40));
    for (let i = start; i < end; i += step) { const a = Math.abs(d[i]); if (a > max) max = a; }
    peaks[b] = max;
  }
  return peaks;
}

function drawWave(i) {
  const t = app.tracks[i];
  const canvas = t.ui.canvas;
  const wrap = t.ui.waveWrap;
  const dpr = window.devicePixelRatio || 1;
  const w = wrap.clientWidth, h = wrap.clientHeight;
  if (!w) return;
  if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
    canvas.width = w * dpr; canvas.height = h * dpr;
  }
  const g = canvas.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, w, h);
  t.ui.hint.style.display = t.buffer ? 'none' : '';
  if (!t.buffer) return;

  const total = songLength();
  const frac = total ? t.buffer.duration / total : 1;
  const barW = 2, gap = 1;
  const buckets = Math.max(1, Math.floor((w * frac) / (barW + gap)));
  const peaks = computePeaks(t.buffer, buckets);
  const mid = h / 2;
  g.fillStyle = waveInk;
  for (let b = 0; b < buckets; b++) {
    const amp = Math.max(1, peaks[b] * (h * 0.86)) / 2;
    const x = b * (barW + gap);
    g.beginPath();
    if (g.roundRect) g.roundRect(x, mid - amp, barW, amp * 2, 1);
    else g.rect(x, mid - amp, barW, amp * 2);
    g.fill();
  }
}

function redrawAllWaves() {
  for (let i = 0; i < NUM_TRACKS; i++) drawWave(i);
  updateTimeUI();
}

function drawPlayheads() {
  const total = songLength();
  const during = app.state === 'recording' ? Math.max(total, currentPos()) : total;
  for (const t of app.tracks) {
    const ph = t.ui.playhead;
    if (!during) { ph.style.display = 'none'; continue; }
    ph.style.display = '';
    const x = clamp(currentPos() / during, 0, 1) * t.ui.waveWrap.clientWidth;
    ph.style.transform = `translateX(${x}px)`;
  }
}

/* ---------------- rAF loop ---------------- */

function currentPos() {
  if (app.state === 'idle' || !app.ctx) return app.pos;
  return Math.max(app.playStartPos, app.playStartPos + (app.ctx.currentTime - app.playStartCtx));
}

function tick() {
  if (app.state !== 'idle') {
    app.pos = currentPos();
    const total = songLength();
    if (app.state === 'playing' && total && app.pos >= total) {
      if (app.loop) { seek(0); }
      else { stopSources(); stopBeatScheduler(); app.state = 'idle'; app.pos = total; releaseWakeLock(); updateTransportUI(); }
    }
    updateTimeUI();
    drawPlayheads();
    updateMeter();
    if (app.state === 'recording') {
      const el = app.tracks[app.recTrack]?.ui.recTime;
      if (el) el.textContent = app.pos > app.recStartPos ? fmtTime(app.pos - app.recStartPos, true) : 'count-in…';
    }
  }
  requestAnimationFrame(tick);
}

function updateMeter() {
  if (app.state !== 'recording' || !app.micAnalyser) return;
  const t = app.tracks[app.recTrack];
  if (!t) return;
  const data = new Float32Array(app.micAnalyser.fftSize);
  app.micAnalyser.getFloatTimeDomainData(data);
  let peak = 0;
  for (let i = 0; i < data.length; i++) { const a = Math.abs(data[i]); if (a > peak) peak = a; }
  t.ui.meter.style.transform = `scaleX(${clamp(peak * 1.15, 0, 1)})`;
}

/* ---------------- export ---------------- */

async function exportMix() {
  const total = songLength();
  if (!total) { toast('Nothing to export yet'); return; }
  ensureCtx();
  toast('Rendering mix…');
  const sr = app.ctx.sampleRate;
  const off = new OfflineAudioContext(2, Math.ceil(total * sr), sr);
  for (const t of app.tracks) {
    if (!t.buffer || t.muted) continue;
    const src = off.createBufferSource();
    src.buffer = t.buffer;
    const g = off.createGain(); g.gain.value = t.volume;
    src.connect(g);
    if (off.createStereoPanner) {
      const p = off.createStereoPanner(); p.pan.value = t.pan;
      g.connect(p); p.connect(off.destination);
    } else g.connect(off.destination);
    src.start(0);
  }
  const rendered = await off.startRendering();

  // Smart export: normalize only if the sum clips, leave headroom otherwise
  let peak = 0;
  const chans = [rendered.getChannelData(0), rendered.getChannelData(1)];
  for (const ch of chans) for (let i = 0; i < ch.length; i++) { const a = Math.abs(ch[i]); if (a > peak) peak = a; }
  if (peak > 0.985) {
    const s = 0.985 / peak;
    for (const ch of chans) for (let i = 0; i < ch.length; i++) ch[i] *= s;
  }

  const wav = encodeWav(chans, sr, false);
  const name = ($('#projectName').value.trim() || 'demo').replace(/[^\w\- ]+/g, '').trim() || 'demo';
  const url = URL.createObjectURL(new Blob([wav], { type: 'audio/wav' }));
  const a = document.createElement('a');
  a.href = url; a.download = `${name}.wav`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
  toast(`Exported “${name}.wav”`);
}

/* ---------------- appearance ---------------- */

function applyAppearance() {
  const root = document.documentElement;
  root.dataset.theme = THEMES[app.prefs.theme] ? app.prefs.theme : 'paper';
  root.style.setProperty('--accent', ACCENTS[app.prefs.accent] || ACCENTS.blue);
  root.style.setProperty('--tex-user', String(app.prefs.texture ?? 1));
  requestAnimationFrame(() => {
    const c = getComputedStyle(root).getPropertyValue('--paper').trim();
    if (c) $('meta[name="theme-color"]').setAttribute('content', c);
    refreshWaveInk();
    redrawAllWaves();
  });
  syncAppearanceUI();
}

async function savePrefs() {
  try { await idb.set('prefs', { ...app.prefs }); } catch (_) {}
}

function buildAppearancePickers() {
  const grid = $('#themeGrid');
  grid.innerHTML = '';
  for (const [key, th] of Object.entries(THEMES)) {
    const b = document.createElement('button');
    b.className = 'theme-swatch';
    b.type = 'button';
    b.dataset.t = key;
    b.setAttribute('role', 'radio');
    b.style.background = th.sw[0];
    b.innerHTML = `<span class="sw-card" style="background:${th.sw[1]}"><i style="background:${th.sw[2]}"></i></span><b style="color:${th.sw[2]}">${th.label}</b>`;
    b.addEventListener('click', () => {
      app.prefs.theme = key;
      applyAppearance(); savePrefs();
    });
    grid.appendChild(b);
  }
  const row = $('#accentRow');
  row.innerHTML = '';
  for (const [key, color] of Object.entries(ACCENTS)) {
    const b = document.createElement('button');
    b.className = 'accent-dot';
    b.type = 'button';
    b.dataset.a = key;
    b.setAttribute('role', 'radio');
    b.setAttribute('aria-label', key);
    b.style.background = color;
    b.addEventListener('click', () => {
      app.prefs.accent = key;
      applyAppearance(); savePrefs();
    });
    row.appendChild(b);
  }
}

function syncAppearanceUI() {
  for (const b of document.querySelectorAll('.theme-swatch')) {
    b.setAttribute('aria-checked', String(b.dataset.t === app.prefs.theme));
  }
  for (const b of document.querySelectorAll('.accent-dot')) {
    b.setAttribute('aria-checked', String(b.dataset.a === app.prefs.accent));
  }
  $('#setTexture').value = Math.round((app.prefs.texture ?? 1) * 100);
}

/* ---------------- projects ---------------- */

const projKey = (id, suffix) => `p:${id}:${suffix}`;
const newProjectId = () => `p_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

function currentSettings() {
  return {
    v: 1,
    projectName: $('#projectName').value,
    bpm: app.bpm, loop: app.loop, met: app.met, metRec: app.metRec,
    metVol: app.metVol, countIn: app.countIn, latencyMs: app.latencyMs,
    tracks: app.tracks.map(t => ({ name: t.name, volume: t.volume, pan: t.pan, muted: t.muted })),
  };
}

let saveTimer = null;
function saveSettingsSoon() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveSettings, 350);
}

async function saveSettings() {
  if (!app.projectId) return;
  try {
    await idb.set(projKey(app.projectId, 'settings'), currentSettings());
    const meta = {
      id: app.projectId,
      name: $('#projectName').value.trim() || 'Untitled',
      updated: Date.now(),
      length: songLength(),
      bpm: app.bpm,
    };
    const idx = app.projectsMeta.findIndex(m => m.id === app.projectId);
    if (idx >= 0) app.projectsMeta[idx] = meta; else app.projectsMeta.push(meta);
    await idb.set('projects', app.projectsMeta);
  } catch (_) {}
}

async function saveTrackAudio(i) {
  if (!app.projectId) return;
  const t = app.tracks[i];
  try {
    if (t.buffer) await idb.set(projKey(app.projectId, `audio${i}`), { sr: t.buffer.sampleRate, wav: bufferToWav(t.buffer, true) });
    else await idb.del(projKey(app.projectId, `audio${i}`));
  } catch (_) { toast('Auto-save failed — storage may be full'); }
}

function applySettings(s) {
  $('#projectName').value = (s && s.projectName) || 'New Demo';
  app.bpm = clamp((s && s.bpm) || 120, 40, 240);
  app.loop = !!(s && s.loop);
  app.met = !!(s && s.met);
  app.metRec = !s || s.metRec !== false;
  app.metVol = (s && s.metVol) ?? 0.6;
  app.countIn = !s || s.countIn !== false;
  app.latencyMs = (s && s.latencyMs) || 0;
  ((s && s.tracks) || []).forEach((m, i) => {
    if (!app.tracks[i]) return;
    Object.assign(app.tracks[i], { name: m.name, volume: m.volume, pan: m.pan, muted: m.muted });
  });
}

async function decodeStoredAudio(rec) {
  if (!rec || !rec.wav) return null;
  const ctx = app.ctx || new (window.AudioContext || window.webkitAudioContext)();
  try { return await ctx.decodeAudioData(rec.wav.slice(0)); }
  catch (_) { return null; }
  finally { if (ctx !== app.ctx && ctx.close) ctx.close(); }
}

async function openProject(id, { quiet = false } = {}) {
  stopAll();
  if (app.projectId && app.projectId !== id) await saveSettings();

  app.projectId = id;
  app.pos = 0;
  const s = await idb.get(projKey(id, 'settings'));
  applySettings(s);
  for (let i = 0; i < NUM_TRACKS; i++) {
    const t = app.tracks[i];
    t.prevBuffer = undefined;
    t.buffer = await decodeStoredAudio(await idb.get(projKey(id, `audio${i}`)));
    if (t.gainNode) applyTrackGain(t);
    if (!s || !s.tracks || !s.tracks[i]) Object.assign(t, { name: `Track ${i + 1}`, volume: 0.9, pan: 0, muted: false });
    refreshTrack(i);
  }
  app.prefs.lastProject = id;
  savePrefs();
  syncSettingsUI();
  updateTransportUI();
  redrawAllWaves();
  drawPlayheads();
  if (!quiet) toast(`Opened “${$('#projectName').value}”`);
}

async function createProject({ quiet = false } = {}) {
  stopAll();
  if (app.projectId) await saveSettings();

  app.projectId = newProjectId();
  app.pos = 0;
  applySettings(null);
  for (let i = 0; i < NUM_TRACKS; i++) {
    const t = app.tracks[i];
    t.buffer = null;
    t.prevBuffer = undefined;
    Object.assign(t, { name: `Track ${i + 1}`, volume: 0.9, pan: 0, muted: false });
    if (t.gainNode) applyTrackGain(t);
    refreshTrack(i);
  }
  app.prefs.lastProject = app.projectId;
  savePrefs();
  await saveSettings();
  syncSettingsUI();
  updateTransportUI();
  redrawAllWaves();
  drawPlayheads();
  if (!quiet) toast('New project');
}

async function deleteProject(id) {
  const meta = app.projectsMeta.find(m => m.id === id);
  const name = (meta && meta.name) || 'this project';
  if (!confirm(`Delete “${name}”? Its tracks will be gone for good.`)) return;
  stopAll();
  await idb.del(projKey(id, 'settings'));
  for (let i = 0; i < NUM_TRACKS; i++) await idb.del(projKey(id, `audio${i}`));
  app.projectsMeta = app.projectsMeta.filter(m => m.id !== id);
  await idb.set('projects', app.projectsMeta);

  if (id === app.projectId) {
    app.projectId = null;
    const next = [...app.projectsMeta].sort((a, b) => b.updated - a.updated)[0];
    if (next) await openProject(next.id, { quiet: true });
    else await createProject({ quiet: true });
  }
  renderProjectList();
  toast('Project deleted');
}

function renderProjectList() {
  const host = $('#projectList');
  host.innerHTML = '';
  const metas = [...app.projectsMeta].sort((a, b) => b.updated - a.updated);
  if (!metas.length) {
    host.innerHTML = '<p class="proj-empty">No projects yet</p>';
    return;
  }
  for (const m of metas) {
    const row = document.createElement('div');
    row.className = 'proj-row' + (m.id === app.projectId ? ' current' : '');
    const date = new Date(m.updated).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    row.innerHTML = `
      <button class="proj-open" type="button">
        <span class="proj-name"></span>
        <span class="proj-sub">${fmtTime(m.length || 0)} · ${m.bpm || 120} bpm · ${date}</span>
      </button>
      <button class="proj-del" type="button" aria-label="Delete project">
        <svg viewBox="0 0 24 24" width="18" height="18"><path fill="currentColor" d="M9 3h6l1 2h4v2H4V5h4l1-2zM6 9h12l-.9 11.1a2 2 0 0 1-2 1.9H8.9a2 2 0 0 1-2-1.9L6 9zm4 3v7h1.5v-7H10zm3 0v7h1.5v-7H13z"/></svg>
      </button>`;
    $('.proj-name', row).textContent = m.name || 'Untitled';
    $('.proj-open', row).addEventListener('click', async () => {
      $('#projectsSheet').hidden = true;
      if (m.id !== app.projectId) await openProject(m.id);
    });
    $('.proj-del', row).addEventListener('click', () => deleteProject(m.id));
    host.appendChild(row);
  }
}

/* Migrate a single-project layout (pre-0.1) into the projects store. */
async function migrateLegacy() {
  try {
    const oldSettings = await idb.get('settings');
    let hasAudio = false;
    for (let i = 0; i < NUM_TRACKS; i++) if (await idb.get(`audio${i}`)) hasAudio = true;
    if (!oldSettings && !hasAudio) return;

    const id = newProjectId();
    await idb.set(projKey(id, 'settings'), oldSettings || {});
    for (let i = 0; i < NUM_TRACKS; i++) {
      const a = await idb.get(`audio${i}`);
      if (a) await idb.set(projKey(id, `audio${i}`), a);
      await idb.del(`audio${i}`);
    }
    await idb.del('settings');
    app.projectsMeta.push({
      id,
      name: (oldSettings && oldSettings.projectName) || 'New Demo',
      updated: Date.now(),
      length: 0,
      bpm: (oldSettings && oldSettings.bpm) || 120,
    });
    await idb.set('projects', app.projectsMeta);
  } catch (_) {}
}

/* ---------------- UI ---------------- */

function toast(msg, ms = 2200) {
  const el = $('#toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { el.hidden = true; }, ms);
}

function buildTracks() {
  const host = $('#tracks');
  for (let i = 0; i < NUM_TRACKS; i++) {
    const t = {
      buffer: null, prevBuffer: undefined,
      name: `Track ${i + 1}`, volume: 0.9, pan: 0, muted: false,
      gainNode: null, panNode: null, ui: {},
    };
    app.tracks.push(t);

    const el = document.createElement('section');
    el.className = 'track';
    el.innerHTML = `
      <button class="rec-btn" aria-label="Record track ${i + 1}" aria-pressed="false" title="Record (${i + 1})"></button>
      <div class="track-body" role="button" tabindex="0" aria-label="Track ${i + 1} options">
        <div class="track-line">
          <span class="track-num">${i + 1}</span>
          <span class="track-title">Track ${i + 1}</span>
          <span class="badge-mute" hidden>muted</span>
          <span class="track-dur"></span>
          <svg class="chev" viewBox="0 0 24 24" width="15" height="15"><path fill="currentColor" d="M9 6l6 6-6 6" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>
        </div>
        <div class="wave-wrap">
          <canvas></canvas>
          <div class="wave-hint">tap ● to record</div>
          <div class="rec-live"><span>● recording <b class="rec-time"></b></span></div>
          <div class="playhead" style="display:none"></div>
          <div class="meter"></div>
        </div>
      </div>`;
    host.appendChild(el);

    t.ui = {
      el,
      body: $('.track-body', el),
      canvas: $('canvas', el),
      waveWrap: $('.wave-wrap', el),
      hint: $('.wave-hint', el),
      playhead: $('.playhead', el),
      meter: $('.meter', el),
      recBtn: $('.rec-btn', el),
      title: $('.track-title', el),
      badgeMute: $('.badge-mute', el),
      dur: $('.track-dur', el),
      recTime: $('.rec-time', el),
    };

    t.ui.recBtn.addEventListener('click', () => toggleRecord(i));

    // One gesture, two meanings: a quick tap opens the track's options;
    // a horizontal drag scrubs the timeline (only if the track has audio).
    const seekAt = (clientX) => {
      const r = t.ui.waveWrap.getBoundingClientRect();
      seek(((clientX - r.left) / r.width) * songLength());
    };
    t.ui.body.addEventListener('pointerdown', (e) => {
      if (e.button != null && e.button !== 0) return;
      const startX = e.clientX, startY = e.clientY;
      let scrubbing = false;
      const move = (ev) => {
        if (!scrubbing) {
          if (Math.abs(ev.clientX - startX) < 8 || Math.abs(ev.clientY - startY) > 14) return;
          if (app.state === 'recording' || !songLength()) return;
          scrubbing = true;
        }
        seekAt(ev.clientX);
      };
      const up = (ev) => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
        if (!scrubbing && app.state !== 'recording') openTrackSheet(i);
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
    });
    t.ui.body.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); openTrackSheet(i); }
    });
  }

  const ro = new ResizeObserver(() => { redrawAllWaves(); drawPlayheads(); });
  ro.observe(host);
}

function refreshTrack(i) {
  const t = app.tracks[i];
  t.ui.title.textContent = t.name || `Track ${i + 1}`;
  t.ui.badgeMute.hidden = !t.muted;
  t.ui.dur.textContent = t.buffer ? fmtTime(t.buffer.duration) : '';
  t.ui.meter.style.transform = 'scaleX(0)';
  if (app.sheetTrack === i && !$('#trackSheet').hidden) syncTrackSheet(i);
}

function updateTransportUI() {
  const playing = app.state !== 'idle';
  $('#playBtn').classList.toggle('is-playing', playing);
  $('#playBtn').setAttribute('aria-label', playing ? 'Stop' : 'Play');
  $('#loopBtn').setAttribute('aria-pressed', String(app.loop));
  $('#metBtn').setAttribute('aria-pressed', String(app.met));
  $('#bpmNum').textContent = app.bpm;
  for (let i = 0; i < NUM_TRACKS; i++) {
    const rec = app.state === 'recording' && app.recTrack === i;
    app.tracks[i].ui.el.classList.toggle('is-recording', rec);
    app.tracks[i].ui.recBtn.setAttribute('aria-pressed', String(rec));
    if (!rec) app.tracks[i].ui.meter.style.transform = 'scaleX(0)';
  }
}

function updateTimeUI() {
  const el = $('#timeDisplay');
  const s = app.state === 'idle' ? app.pos : currentPos();
  el.innerHTML = `${fmtTime(s)}<span class="time-frac">.${Math.floor((Math.max(0, s) % 1) * 10)}</span>`;
  const total = songLength();
  $('#lengthDisplay').textContent = total ? `of ${fmtTime(total)} · ${app.bpm} bpm` : 'ready to record';
}

/* ---------------- sheets ---------------- */

function syncSettingsUI() {
  $('#setCountIn').checked = app.countIn;
  $('#setMetRec').checked = app.metRec;
  $('#setMetVol').value = Math.round(app.metVol * 100);
  $('#setLatency').value = app.latencyMs;
  $('#latencyLabel').textContent = `auto ${app.latencyMs >= 0 ? '+' : '−'} ${Math.abs(app.latencyMs)} ms`;
}

function closeSheets() {
  $('#settingsSheet').hidden = true;
  $('#projectsSheet').hidden = true;
  $('#trackSheet').hidden = true;
}

/* ---- per-track options sheet ---- */

function panLabel(pan) {
  const p = Math.round(pan * 100);
  if (p === 0) return 'center';
  return `${Math.abs(p)}% ${p < 0 ? 'left' : 'right'}`;
}

function syncTrackSheet(i) {
  const t = app.tracks[i];
  $('#tsNum').textContent = String(i + 1);
  if (document.activeElement !== $('#tsName')) $('#tsName').value = t.name;
  $('#tsDur').textContent = t.buffer ? fmtTime(t.buffer.duration) : 'empty';
  $('#tsVol').value = Math.round(t.volume * 100);
  $('#tsPan').value = Math.round(t.pan * 100);
  $('#tsPanLabel').textContent = panLabel(t.pan);
  $('#tsMute').checked = t.muted;
  $('#tsUndo').disabled = t.prevBuffer === undefined;
  $('#tsClear').disabled = !t.buffer;
}

function openTrackSheet(i) {
  app.sheetTrack = i;
  syncTrackSheet(i);
  $('#settingsSheet').hidden = true;
  $('#projectsSheet').hidden = true;
  $('#trackSheet').hidden = false;
}

function wireTrackSheet() {
  const cur = () => app.tracks[app.sheetTrack];
  $('#tsName').addEventListener('input', () => {
    const t = cur(); if (!t) return;
    t.name = $('#tsName').value;
    t.ui.title.textContent = t.name || `Track ${app.sheetTrack + 1}`;
    saveSettingsSoon();
  });
  $('#tsVol').addEventListener('input', () => {
    const t = cur(); if (!t) return;
    t.volume = $('#tsVol').value / 100;
    if (app.ctx) applyTrackGain(t);
    saveSettingsSoon();
  });
  $('#tsPan').addEventListener('input', () => {
    const t = cur(); if (!t) return;
    t.pan = $('#tsPan').value / 100;
    $('#tsPanLabel').textContent = panLabel(t.pan);
    if (app.ctx) applyTrackGain(t);
    saveSettingsSoon();
  });
  $('#tsMute').addEventListener('change', () => {
    const t = cur(); if (!t) return;
    t.muted = $('#tsMute').checked;
    if (app.ctx) applyTrackGain(t);
    refreshTrack(app.sheetTrack); saveSettingsSoon();
  });
  $('#tsUndo').addEventListener('click', () => {
    const t = cur(); if (!t || t.prevBuffer === undefined) return;
    [t.buffer, t.prevBuffer] = [t.prevBuffer, t.buffer];
    refreshTrack(app.sheetTrack); redrawAllWaves(); saveTrackAudio(app.sheetTrack); saveSettingsSoon();
    toast(t.buffer ? 'Previous take restored' : 'Take removed — Undo again to bring it back');
  });
  $('#tsClear').addEventListener('click', () => {
    const t = cur(); if (!t || !t.buffer) return;
    t.prevBuffer = t.buffer;
    t.buffer = null;
    refreshTrack(app.sheetTrack); redrawAllWaves(); saveTrackAudio(app.sheetTrack); saveSettingsSoon();
    toast('Track cleared — Undo take to restore');
  });
  $('#tsDone').addEventListener('click', closeSheets);
  $('#trackSheet').addEventListener('click', (e) => { if (e.target === $('#trackSheet')) closeSheets(); });
}

function wireSheets() {
  $('#settingsBtn').addEventListener('click', () => {
    syncSettingsUI(); syncAppearanceUI();
    $('#projectsSheet').hidden = true;
    $('#settingsSheet').hidden = false;
  });
  $('#projectsBtn').addEventListener('click', async () => {
    await saveSettings();      // so the list shows fresh names/lengths
    renderProjectList();
    $('#settingsSheet').hidden = true;
    $('#projectsSheet').hidden = false;
  });
  $('#closeSettingsBtn').addEventListener('click', closeSheets);
  for (const id of ['settingsSheet', 'projectsSheet']) {
    $(`#${id}`).addEventListener('click', (e) => { if (e.target === $(`#${id}`)) closeSheets(); });
  }
  $('#newProjectBtn').addEventListener('click', async () => {
    closeSheets();
    await createProject();
  });
  $('#setCountIn').addEventListener('change', (e) => { app.countIn = e.target.checked; saveSettingsSoon(); });
  $('#setMetRec').addEventListener('change', (e) => { app.metRec = e.target.checked; saveSettingsSoon(); });
  $('#setMetVol').addEventListener('input', (e) => { app.metVol = e.target.value / 100; saveSettingsSoon(); });
  $('#setLatency').addEventListener('input', (e) => {
    app.latencyMs = +e.target.value;
    $('#latencyLabel').textContent = `auto ${app.latencyMs >= 0 ? '+' : '−'} ${Math.abs(app.latencyMs)} ms`;
    saveSettingsSoon();
  });
  $('#setTexture').addEventListener('input', (e) => {
    app.prefs.texture = e.target.value / 100;
    document.documentElement.style.setProperty('--tex-user', String(app.prefs.texture));
    savePrefs();
  });
  $('#deleteProjectBtn').addEventListener('click', () => {
    closeSheets();
    deleteProject(app.projectId);
  });
}

/* ---------------- transport wiring ---------------- */

function setBpm(v) {
  app.bpm = clamp(Math.round(v), 40, 240);
  $('#bpmNum').textContent = app.bpm;
  updateTimeUI();
  saveSettingsSoon();
}

function holdRepeat(btn, fn) {
  let t1, t2;
  const start = (e) => {
    e.preventDefault();
    fn();
    t1 = setTimeout(() => { t2 = setInterval(fn, 70); }, 450);
  };
  const end = () => { clearTimeout(t1); clearInterval(t2); };
  btn.addEventListener('pointerdown', start);
  for (const ev of ['pointerup', 'pointerleave', 'pointercancel']) btn.addEventListener(ev, end);
}

function wireTransport() {
  $('#playBtn').addEventListener('click', () => { app.state === 'idle' ? play() : stopAll(); });
  $('#rtzBtn').addEventListener('click', () => seek(0));
  $('#loopBtn').addEventListener('click', () => { app.loop = !app.loop; updateTransportUI(); saveSettingsSoon(); });
  $('#metBtn').addEventListener('click', () => {
    app.met = !app.met;
    if (app.met) { ensureCtx(); click(app.ctx.currentTime + 0.01, true); }
    updateTransportUI(); saveSettingsSoon();
  });
  holdRepeat($('#bpmDown'), () => setBpm(app.bpm - 1));
  holdRepeat($('#bpmUp'), () => setBpm(app.bpm + 1));
  $('#bpmTap').addEventListener('click', () => {
    ensureCtx();
    const now = performance.now();
    if (app.taps.length && now - app.taps[app.taps.length - 1] > 2000) app.taps = [];
    app.taps.push(now);
    if (app.taps.length > 6) app.taps.shift();
    if (app.taps.length >= 2) {
      const iv = (app.taps[app.taps.length - 1] - app.taps[0]) / (app.taps.length - 1);
      setBpm(60000 / iv);
    }
    click(app.ctx.currentTime + 0.01, false);
  });
  $('#exportBtn').addEventListener('click', exportMix);
  $('#projectName').addEventListener('input', saveSettingsSoon);
}

/* ---------------- keyboard ---------------- */

function wireKeyboard() {
  window.addEventListener('keydown', (e) => {
    if (e.target.matches('input[type="text"], input:not([type]), [contenteditable]')) return;
    if (e.repeat) return;
    switch (e.key) {
      case ' ':
        e.preventDefault();
        if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
        app.state === 'idle' ? play() : stopAll();
        break;
      case 'Enter': seek(0); break;
      case '1': case '2': case '3': case '4': toggleRecord(+e.key - 1); break;
      case 'm': case 'M': $('#metBtn').click(); break;
      case 'l': case 'L': $('#loopBtn').click(); break;
      case 'e': case 'E': exportMix(); break;
      case 'Escape': if (app.state !== 'idle') stopAll(); else closeSheets(); break;
    }
  });
}

/* ---------------- wake lock ---------------- */

async function requestWakeLock() {
  try { app.wakeLock = await navigator.wakeLock?.request('screen'); } catch (_) {}
}
function releaseWakeLock() {
  try { app.wakeLock?.release(); } catch (_) {}
  app.wakeLock = null;
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && app.state !== 'idle') requestWakeLock();
});

/* ---------------- forced updates ----------------
   Two independent mechanisms, so a stale service worker on someone's
   phone can't silently hide a new release forever:

   1. Standard SW update flow — new sw.js is detected, installs, takes
      over, and reloads the idle page once via 'controllerchange'.
   2. A direct version.json check (bypassing the SW/HTTP cache entirely)
      that nukes any service worker + cache and force-reloads whenever
      the served version doesn't match what's running. This is the one
      that actually breaks a wedged old worker, since it doesn't depend
      on that worker's own update logic ever running. */

async function checkForUpdate() {
  try {
    const res = await fetch(`version.json?t=${Date.now()}`, { cache: 'no-store' });
    if (!res.ok) return;
    const data = await res.json();
    if (data.version && data.version !== APP_VERSION) forceUpdate(data.version);
  } catch (_) {}
}

async function forceUpdate(newVersion) {
  if (app.state !== 'idle') return; // never interrupt a take or playback
  const guardKey = `4track_forced_${newVersion}`;
  if (sessionStorage.getItem(guardKey)) return; // already tried this version this session
  sessionStorage.setItem(guardKey, '1');
  try {
    if ('serviceWorker' in navigator) {
      const regs = await navigator.serviceWorker.getRegistrations();
      await Promise.all(regs.map((r) => r.unregister()));
    }
    if ('caches' in window) {
      const keys = await caches.keys();
      await Promise.all(keys.map((k) => caches.delete(k)));
    }
  } catch (_) {}
  location.reload();
}

function wireServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  window.addEventListener('load', async () => {
    try {
      const reg = await navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' });
      reg.update();
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') reg.update().catch(() => {});
      });
    } catch (_) {}
  });
  const hadController = !!navigator.serviceWorker.controller;
  let reloaded = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (reloaded || !hadController) return;
    if (app.state !== 'idle') return;
    reloaded = true;
    location.reload();
  });
}

function wireUpdateChecks() {
  setTimeout(checkForUpdate, 1200);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') checkForUpdate();
  });
  window.addEventListener('focus', checkForUpdate);
}

/* ---------------- boot ---------------- */

async function boot() {
  buildTracks();
  buildAppearancePickers();
  wireTransport();
  wireSheets();
  wireTrackSheet();
  wireKeyboard();
  updateTransportUI();
  updateTimeUI();
  requestAnimationFrame(tick);
  wireServiceWorker();
  wireUpdateChecks();

  try {
    const prefs = await idb.get('prefs');
    if (prefs) Object.assign(app.prefs, prefs);
  } catch (_) {}
  applyAppearance();

  try {
    app.projectsMeta = (await idb.get('projects')) || [];
    if (!app.projectsMeta.length) await migrateLegacy();

    if (app.projectsMeta.length) {
      const last = app.projectsMeta.find(m => m.id === app.prefs.lastProject)
        || [...app.projectsMeta].sort((a, b) => b.updated - a.updated)[0];
      await openProject(last.id, { quiet: true });
      if (songLength()) toast('Project restored');
    } else {
      await createProject({ quiet: true });
    }
  } catch (_) {
    if (!app.projectId) createProject({ quiet: true });
  }
}

boot();
