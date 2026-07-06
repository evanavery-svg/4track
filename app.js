'use strict';

/* Four Track — a minimalist 4-track recorder.
   Web Audio + MediaRecorder, no dependencies. */

const NUM_TRACKS = 4;
const BEATS_PER_BAR = 4;

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

  tracks: [],           // { buffer, prevBuffer, name, volume, pan, muted, gainNode, panNode, ui:{} }
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

  const t = app.tracks[i];
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
  g.fillStyle = 'rgba(60, 58, 54, 0.72)';
  for (let b = 0; b < buckets; b++) {
    const amp = Math.max(1, peaks[b] * (h * 0.86) / 2 * 2) / 2;
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

/* ---------------- persistence ---------------- */

let saveTimer = null;
function saveSettingsSoon() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveSettings, 350);
}

async function saveSettings() {
  try {
    await idb.set('settings', {
      v: 1,
      projectName: $('#projectName').value,
      bpm: app.bpm, loop: app.loop, met: app.met, metRec: app.metRec,
      metVol: app.metVol, countIn: app.countIn, latencyMs: app.latencyMs,
      tracks: app.tracks.map(t => ({ name: t.name, volume: t.volume, pan: t.pan, muted: t.muted })),
    });
  } catch (_) {}
}

async function saveTrackAudio(i) {
  const t = app.tracks[i];
  try {
    if (t.buffer) await idb.set(`audio${i}`, { sr: t.buffer.sampleRate, wav: bufferToWav(t.buffer, true) });
    else await idb.del(`audio${i}`);
  } catch (_) { toast('Auto-save failed — storage may be full'); }
}

async function restore() {
  try {
    const s = await idb.get('settings');
    if (s) {
      $('#projectName').value = s.projectName || 'New Demo';
      app.bpm = clamp(s.bpm || 120, 40, 240);
      app.loop = !!s.loop; app.met = !!s.met;
      app.metRec = s.metRec !== false;
      app.metVol = s.metVol ?? 0.6;
      app.countIn = s.countIn !== false;
      app.latencyMs = s.latencyMs || 0;
      (s.tracks || []).forEach((m, i) => {
        if (!app.tracks[i]) return;
        Object.assign(app.tracks[i], { name: m.name, volume: m.volume, pan: m.pan, muted: m.muted });
      });
    }
    // decode saved audio with a throwaway offline context (no user gesture needed)
    const dec = new (window.AudioContext || window.webkitAudioContext)();
    let any = false;
    for (let i = 0; i < NUM_TRACKS; i++) {
      const rec = await idb.get(`audio${i}`);
      if (rec && rec.wav) {
        try { app.tracks[i].buffer = await dec.decodeAudioData(rec.wav.slice(0)); any = true; }
        catch (_) {}
      }
    }
    dec.close && dec.close();
    for (let i = 0; i < NUM_TRACKS; i++) refreshTrack(i);
    syncSettingsUI();
    updateTransportUI();
    redrawAllWaves();
    if (any) toast('Project restored');
  } catch (_) {}
}

async function eraseProject() {
  if (!confirm('Erase all tracks and settings? This cannot be undone.')) return;
  stopAll();
  for (let i = 0; i < NUM_TRACKS; i++) {
    app.tracks[i].buffer = null;
    app.tracks[i].prevBuffer = undefined;
    Object.assign(app.tracks[i], { name: `Track ${i + 1}`, volume: 0.9, pan: 0, muted: false });
    await idb.del(`audio${i}`);
    refreshTrack(i);
  }
  $('#projectName').value = 'New Demo';
  app.pos = 0;
  await idb.del('settings');
  redrawAllWaves();
  drawPlayheads();
  closeSettings();
  toast('Project erased');
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
      <div class="track-top">
        <span class="track-num">${i + 1}</span>
        <input class="track-name" value="Track ${i + 1}" maxlength="24" aria-label="Track ${i + 1} name" autocomplete="off" spellcheck="false">
        <span class="track-dur"></span>
      </div>
      <div class="wave-wrap" role="slider" aria-label="Track ${i + 1} timeline">
        <canvas></canvas>
        <div class="wave-hint">tap ● to record</div>
        <div class="rec-live"><span>● recording <b class="rec-time"></b></span></div>
        <div class="playhead" style="display:none"></div>
        <div class="meter"></div>
      </div>
      <div class="track-ctls">
        <button class="rec-btn" aria-label="Record track ${i + 1}" aria-pressed="false" title="Record (${i + 1})"></button>
        <button class="pill-btn mute-btn" aria-pressed="false" title="Mute">M</button>
        <div class="sliders">
          <div class="slider-row">
            <svg viewBox="0 0 24 24" width="13" height="13"><path fill="currentColor" d="M3 9v6h4l5 5V4L7 9H3zm13.5 3A4.5 4.5 0 0 0 14 8v8a4.5 4.5 0 0 0 2.5-4z"/></svg>
            <input type="range" class="vol" min="0" max="100" value="90" aria-label="Volume">
          </div>
          <div class="slider-row">
            <svg viewBox="0 0 24 24" width="13" height="13"><path fill="currentColor" d="M4 11h7V4h2v7h7v2h-7v7h-2v-7H4z" transform="rotate(90 12 12)"/></svg>
            <input type="range" class="pan" min="-100" max="100" value="0" aria-label="Pan">
          </div>
        </div>
        <button class="pill-btn undo-btn" title="Undo take" disabled>↩︎</button>
        <button class="pill-btn clear-btn" title="Clear track" disabled>✕</button>
      </div>`;
    host.appendChild(el);

    t.ui = {
      el,
      canvas: $('canvas', el),
      waveWrap: $('.wave-wrap', el),
      hint: $('.wave-hint', el),
      playhead: $('.playhead', el),
      meter: $('.meter', el),
      recBtn: $('.rec-btn', el),
      muteBtn: $('.mute-btn', el),
      undoBtn: $('.undo-btn', el),
      clearBtn: $('.clear-btn', el),
      nameInput: $('.track-name', el),
      dur: $('.track-dur', el),
      vol: $('.vol', el),
      pan: $('.pan', el),
      recTime: $('.rec-time', el),
    };

    t.ui.recBtn.addEventListener('click', () => toggleRecord(i));
    t.ui.muteBtn.addEventListener('click', () => {
      t.muted = !t.muted;
      if (app.ctx) applyTrackGain(t);
      refreshTrack(i); saveSettingsSoon();
    });
    t.ui.vol.addEventListener('input', () => {
      t.volume = t.ui.vol.value / 100;
      if (app.ctx) applyTrackGain(t);
      saveSettingsSoon();
    });
    t.ui.pan.addEventListener('input', () => {
      t.pan = t.ui.pan.value / 100;
      if (app.ctx) applyTrackGain(t);
      saveSettingsSoon();
    });
    t.ui.undoBtn.addEventListener('click', () => {
      if (t.prevBuffer === undefined) return;
      [t.buffer, t.prevBuffer] = [t.prevBuffer, t.buffer];
      refreshTrack(i); redrawAllWaves(); saveTrackAudio(i);
      toast(t.buffer ? 'Previous take restored' : 'Take removed — tap ↩︎ to bring it back');
    });
    t.ui.clearBtn.addEventListener('click', () => {
      if (!t.buffer) return;
      t.prevBuffer = t.buffer;
      t.buffer = null;
      refreshTrack(i); redrawAllWaves(); saveTrackAudio(i);
      toast('Track cleared — tap ↩︎ to undo');
    });
    t.ui.nameInput.addEventListener('input', () => { t.name = t.ui.nameInput.value; saveSettingsSoon(); });

    // click / drag to seek
    const onSeek = (e) => {
      const r = t.ui.waveWrap.getBoundingClientRect();
      const x = (e.touches ? e.touches[0].clientX : e.clientX) - r.left;
      seek((x / r.width) * songLength());
    };
    t.ui.waveWrap.addEventListener('pointerdown', (e) => {
      if (app.state === 'recording' || !songLength()) return;
      onSeek(e);
      const move = (ev) => onSeek(ev);
      const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
    });
  }

  const ro = new ResizeObserver(() => { redrawAllWaves(); drawPlayheads(); });
  ro.observe(host);
}

function refreshTrack(i) {
  const t = app.tracks[i];
  t.ui.nameInput.value = t.name;
  t.ui.vol.value = Math.round(t.volume * 100);
  t.ui.pan.value = Math.round(t.pan * 100);
  t.ui.muteBtn.setAttribute('aria-pressed', String(t.muted));
  t.ui.undoBtn.disabled = t.prevBuffer === undefined;
  t.ui.clearBtn.disabled = !t.buffer;
  t.ui.dur.textContent = t.buffer ? fmtTime(t.buffer.duration) : '';
  t.ui.meter.style.transform = 'scaleX(0)';
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

/* ---------------- settings sheet ---------------- */

function syncSettingsUI() {
  $('#setCountIn').checked = app.countIn;
  $('#setMetRec').checked = app.metRec;
  $('#setMetVol').value = Math.round(app.metVol * 100);
  $('#setLatency').value = app.latencyMs;
  $('#latencyLabel').textContent = `auto ${app.latencyMs >= 0 ? '+' : '−'} ${Math.abs(app.latencyMs)} ms`;
}

function closeSettings() { $('#settingsSheet').hidden = true; }

function wireSettings() {
  $('#settingsBtn').addEventListener('click', () => { syncSettingsUI(); $('#settingsSheet').hidden = false; });
  $('#closeSettingsBtn').addEventListener('click', closeSettings);
  $('#settingsSheet').addEventListener('click', (e) => { if (e.target === $('#settingsSheet')) closeSettings(); });
  $('#setCountIn').addEventListener('change', (e) => { app.countIn = e.target.checked; saveSettingsSoon(); });
  $('#setMetRec').addEventListener('change', (e) => { app.metRec = e.target.checked; saveSettingsSoon(); });
  $('#setMetVol').addEventListener('input', (e) => { app.metVol = e.target.value / 100; saveSettingsSoon(); });
  $('#setLatency').addEventListener('input', (e) => {
    app.latencyMs = +e.target.value;
    $('#latencyLabel').textContent = `auto ${app.latencyMs >= 0 ? '+' : '−'} ${Math.abs(app.latencyMs)} ms`;
    saveSettingsSoon();
  });
  $('#clearProjectBtn').addEventListener('click', eraseProject);
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
      case 'Escape': if (app.state !== 'idle') stopAll(); else closeSettings(); break;
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

/* ---------------- boot ---------------- */

buildTracks();
wireTransport();
wireSettings();
wireKeyboard();
updateTransportUI();
updateTimeUI();
requestAnimationFrame(tick);
restore();

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
}
