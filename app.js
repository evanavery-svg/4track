'use strict';

/* Crumple — a minimalist 4-track recorder.
   Web Audio + MediaRecorder, no dependencies. */

const APP_VERSION = '0.12';
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
  livePeaks: [],        // {p: timeline pos, v: peak} sampled while recording

  state: 'idle',        // idle | playing | recording
  pos: 0,               // timeline position in seconds
  playStartCtx: 0,
  playStartPos: 0,
  sources: [],

  bpm: 120,
  loop: false,
  loopA: null,          // loop region start (s), null = song start
  loopB: null,          // loop region end (s), null = song end
  met: false,
  metRec: true,
  metVol: 0.6,
  countIn: true,
  beatsPerBar: 4,       // time signature (top number)
  subdiv: 1,            // metronome subdivisions per beat (1,2,3,4)
  latencyMs: 0,
  nextTick: 0,
  schedTimer: null,

  exportBlob: null,
  exportName: 'demo',

  lofi: false,
  lofiAmt: 0.8,
  busInput: null,
  lofiChain: null,
  micSourceNode: null,
  monitorGain: null,
  monitorRaf: null,

  recMono: null,
  recInputGain: null,
  recDest: null,

  tunerAnalyser: null,
  tunerTimer: null,
  tunerSmooth: 0,

  outputPre: null,
  outputComp: null,

  projectId: null,
  projectsMeta: [],     // [{ id, name, updated, length, bpm }]
  prefs: { theme: 'paper', accent: 'blue', texture: 1, micGain: 1, speakerBoost: false, lastProject: null },

  tracks: [],           // { buffer, prevBuffer, name, volume, pan, muted, gainNode, panNode, ui:{} }
  sheetTrack: -1,
  sheetZoom: 1,
  wakeLock: null,
  taps: [],
};

const songLength = () =>
  app.tracks.reduce((m, t) => Math.max(m, t.buffer ? t.buffer.duration : 0), 0);

function ensureCtx() {
  if (!app.ctx) {
    app.ctx = new (window.AudioContext || window.webkitAudioContext)({ latencyHint: 'interactive' });
    app.master = app.ctx.createGain();
    rebuildOutputStage();                    // master -> [speaker boost] -> destination
    app.busInput = app.ctx.createGain();     // all tracks feed into master; lofi sits between bus and master
    for (const t of app.tracks) {
      t.gainNode = app.ctx.createGain();
      t.panNode = app.ctx.createStereoPanner ? app.ctx.createStereoPanner() : null;
      t.toneLow = app.ctx.createBiquadFilter(); t.toneLow.type = 'lowshelf'; t.toneLow.frequency.value = 320;
      t.toneHigh = app.ctx.createBiquadFilter(); t.toneHigh.type = 'highshelf'; t.toneHigh.frequency.value = 3200;
      // gain -> [pan] -> toneLow -> toneHigh -> busInput
      t.gainNode.connect(t.panNode || t.toneLow);
      if (t.panNode) t.panNode.connect(t.toneLow);
      t.toneLow.connect(t.toneHigh);
      t.toneHigh.connect(app.busInput);
      applyTrackGain(t);
      applyTone(t);
    }
    rebuildLoFi();
  }
  if (app.ctx.state === 'suspended') app.ctx.resume();
  return app.ctx;
}

const anySolo = () => app.tracks.some(t => t.solo);

function applyTrackGain(t) {
  if (!t.gainNode) return;
  const silent = t.muted || (anySolo() && !t.solo);
  t.gainNode.gain.setTargetAtTime(silent ? 0 : t.volume, app.ctx.currentTime, 0.015);
  if (t.panNode) t.panNode.pan.setTargetAtTime(t.pan, app.ctx.currentTime, 0.015);
}

function applyAllGains() { if (app.ctx) for (const t of app.tracks) applyTrackGain(t); }

function applyTone(t) {
  if (!t.toneLow) return;
  const v = clamp(t.tone || 0, -1, 1);       // -1 dark … +1 bright (tilt EQ)
  const g = 13 * v;
  t.toneLow.gain.setTargetAtTime(-g, app.ctx.currentTime, 0.02);
  t.toneHigh.gain.setTargetAtTime(g, app.ctx.currentTime, 0.02);
}

/* ---------------- Lo-Fi effect (tape/cassette crush) ---------------- */

function makeSaturationCurve(amt) {
  const n = 1024, curve = new Float32Array(n);
  const k = 1 + amt * 45;
  for (let i = 0; i < n; i++) { const x = (i / (n - 1)) * 2 - 1; curve[i] = Math.tanh(k * x) / Math.tanh(k); }
  return curve;
}
function makeCrushCurve(bits) {
  const n = 2048, curve = new Float32Array(n), levels = Math.pow(2, bits);
  for (let i = 0; i < n; i++) { const x = (i / (n - 1)) * 2 - 1; curve[i] = Math.round(x * levels) / levels; }
  return curve;
}
function makeNoiseBuffer(ctx, seconds = 2.2) {
  const len = Math.floor(ctx.sampleRate * seconds);
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
  return buf;
}

// Context-agnostic: builds the same crushed chain for live playback and export.
function buildLoFiChain(ctx, amt) {
  amt = clamp(amt, 0, 1);
  const input = ctx.createGain();
  const output = ctx.createGain();

  const hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 120 + amt * 260;
  const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 6200 - amt * 3300; lp.Q.value = 0.9;
  const sat = ctx.createWaveShaper(); sat.curve = makeSaturationCurve(amt); sat.oversample = '2x';
  const crush = ctx.createWaveShaper(); crush.curve = makeCrushCurve(Math.round(9 - amt * 4)); // 9..5 bits
  const wow = ctx.createDelay(0.05); wow.delayTime.value = 0.006;

  // wow (slow) + flutter (fast) pitch wobble via modulated delay time
  const lfo = ctx.createOscillator(); lfo.type = 'sine'; lfo.frequency.value = 0.7 + amt * 1.3;
  const lfoG = ctx.createGain(); lfoG.gain.value = 0.0008 + amt * 0.0038;
  lfo.connect(lfoG); lfoG.connect(wow.delayTime); lfo.start();
  const flut = ctx.createOscillator(); flut.type = 'sine'; flut.frequency.value = 6 + amt * 5;
  const flutG = ctx.createGain(); flutG.gain.value = 0.00015 + amt * 0.0009;
  flut.connect(flutG); flutG.connect(wow.delayTime); flut.start();

  input.connect(hp); hp.connect(lp); lp.connect(sat); sat.connect(crush); crush.connect(wow); wow.connect(output);

  // tape hiss — gentle; it's seasoning, not the main course
  const noise = ctx.createBufferSource(); noise.buffer = makeNoiseBuffer(ctx); noise.loop = true;
  const noiseHp = ctx.createBiquadFilter(); noiseHp.type = 'highpass'; noiseHp.frequency.value = 1400;
  const noiseLp = ctx.createBiquadFilter(); noiseLp.type = 'lowpass'; noiseLp.frequency.value = 7000;
  const noiseG = ctx.createGain(); noiseG.gain.value = 0.0009 + amt * 0.005;
  noise.connect(noiseHp); noiseHp.connect(noiseLp); noiseLp.connect(noiseG); noiseG.connect(output);
  noise.start();

  output.gain.value = 1 + amt * 0.25;         // makeup for filtering losses
  return { input, output, _sources: [lfo, flut, noise] };
}

function rebuildLoFi() {
  if (!app.ctx || !app.busInput) return;
  try { app.busInput.disconnect(); } catch (_) {}
  if (app.lofiChain) {
    try { app.lofiChain._sources.forEach(s => s.stop && s.stop()); } catch (_) {}
    try { app.lofiChain.output.disconnect(); } catch (_) {}
    app.lofiChain = null;
  }
  if (app.lofi) {
    app.lofiChain = buildLoFiChain(app.ctx, app.lofiAmt);
    app.busInput.connect(app.lofiChain.input);
    app.lofiChain.output.connect(app.master);
  } else {
    app.busInput.connect(app.master);
  }
}

/* Speaker boost: phone speakers are physically quiet and can't be made
   louder by a web page — the OS volume is out of reach. What DOES help is
   driving the signal harder into a fast limiter so quiet mixes sound louder
   without clipping. Playback-only; export stays clean/untouched so shared
   files aren't artificially squashed. */
function rebuildOutputStage() {
  if (!app.ctx || !app.master) return;
  try { app.master.disconnect(); } catch (_) {}
  if (app.outputPre) { try { app.outputPre.disconnect(); } catch (_) {} app.outputPre = null; }
  if (app.outputComp) { try { app.outputComp.disconnect(); } catch (_) {} app.outputComp = null; }

  if (app.prefs.speakerBoost) {
    app.outputPre = app.ctx.createGain();
    app.outputPre.gain.value = 3.2;   // drive hard into the limiter (~+10dB)
    app.outputComp = app.ctx.createDynamicsCompressor();
    app.outputComp.threshold.value = -8;
    app.outputComp.knee.value = 0;
    app.outputComp.ratio.value = 20;   // near brick-wall at Web Audio's ceiling
    app.outputComp.attack.value = 0.001;
    app.outputComp.release.value = 0.1;
    app.master.connect(app.outputPre);
    app.outputPre.connect(app.outputComp);
    app.outputComp.connect(app.ctx.destination);
  } else {
    app.master.connect(app.ctx.destination);
  }
}

/* ---------------- input monitor / level check ---------------- */

async function setMonitor(on) {
  if (!on) { stopMonitor(); return; }
  ensureCtx();
  try { await getMic(); }
  catch (_) { toast('Microphone access is needed'); syncMonitorUI(); return; }
  if (!app.monitorGain) {
    app.monitorGain = app.ctx.createGain();
    app.monitorGain.gain.value = 1;
    app.recInputGain.connect(app.monitorGain);      // hear the post-sensitivity signal
    app.monitorGain.connect(app.ctx.destination);   // dry, pre-effects monitoring — persists through recording
  }
  toast('Monitoring input — use headphones to avoid feedback');
  startMonitorMeter();
  syncMonitorUI();
}

function stopMonitor() {
  if (app.monitorGain) {
    try { app.recInputGain && app.recInputGain.disconnect(app.monitorGain); } catch (_) {}
    try { app.monitorGain.disconnect(); } catch (_) {}
    app.monitorGain = null;
  }
  stopMonitorMeter();
  syncMonitorUI();
}

function syncMonitorUI() {
  const on = !!app.monitorGain;
  const sw = $('#tsMonitor'); if (sw) sw.checked = on;
  const badge = $('#monitorBadge');
  if (badge) badge.setAttribute('aria-pressed', String(on));
}

function startMonitorMeter() {
  stopMonitorMeter();
  const bar = $('#tsLevelFill');
  const loop = () => {
    if (!app.micAnalyser) return;
    const data = new Float32Array(app.micAnalyser.fftSize);
    app.micAnalyser.getFloatTimeDomainData(data);
    let peak = 0;
    for (let i = 0; i < data.length; i++) { const a = Math.abs(data[i]); if (a > peak) peak = a; }
    if (bar) bar.style.transform = `scaleX(${clamp(peak * 1.15, 0, 1)})`;
    app.monitorRaf = requestAnimationFrame(loop);
  };
  loop();
}
function stopMonitorMeter() {
  if (app.monitorRaf) { cancelAnimationFrame(app.monitorRaf); app.monitorRaf = null; }
  const bar = $('#tsLevelFill'); if (bar) bar.style.transform = 'scaleX(0)';
}

/* ---------------- tuner (autocorrelation pitch detection) ---------------- */

const NOTE_NAMES = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B'];
const noteFromPitch = (freq) => Math.round(12 * Math.log2(freq / 440) + 69);
const freqFromNote = (n) => 440 * Math.pow(2, (n - 69) / 12);
const centsOff = (freq, n) => Math.round(1200 * Math.log2(freq / freqFromNote(n)));

function autoCorrelate(buf, sampleRate) {
  const SIZE = buf.length;
  let rms = 0;
  for (let i = 0; i < SIZE; i++) rms += buf[i] * buf[i];
  rms = Math.sqrt(rms / SIZE);
  if (rms < 0.008) return -1;                 // too quiet to trust

  // trim leading/trailing near-silence
  let r1 = 0, r2 = SIZE - 1;
  const thres = 0.2;
  for (let i = 0; i < SIZE / 2; i++) if (Math.abs(buf[i]) < thres) { r1 = i; break; }
  for (let i = 1; i < SIZE / 2; i++) if (Math.abs(buf[SIZE - i]) < thres) { r2 = SIZE - i; break; }
  const b = buf.slice(r1, r2);
  const n = b.length;
  if (n < 128) return -1;

  const c = new Float32Array(n);
  for (let i = 0; i < n; i++) for (let j = 0; j < n - i; j++) c[i] += b[j] * b[j + i];

  let d = 0; while (d < n - 1 && c[d] > c[d + 1]) d++;
  let maxval = -1, maxpos = -1;
  for (let i = d; i < n; i++) if (c[i] > maxval) { maxval = c[i]; maxpos = i; }
  let T0 = maxpos;
  if (T0 <= 0) return -1;

  // parabolic interpolation around the peak for sub-sample accuracy
  const x1 = c[T0 - 1] || 0, x2 = c[T0], x3 = c[T0 + 1] || 0;
  const a = (x1 + x3 - 2 * x2) / 2, bb = (x3 - x1) / 2;
  if (a) T0 = T0 - bb / (2 * a);

  const freq = sampleRate / T0;
  return (freq >= 55 && freq <= 1500) ? freq : -1;   // plausible guitar range
}

async function openTuner() {
  ensureCtx();
  try { await getMic(); }
  catch (_) { toast('Microphone access is needed to tune'); return; }
  if (!app.tunerAnalyser) {
    app.tunerAnalyser = app.ctx.createAnalyser();
    app.tunerAnalyser.fftSize = 4096;
    app.recInputGain.connect(app.tunerAnalyser);
  }
  closeSheets();
  $('#tunerSheet').hidden = false;
  app.tunerSmooth = 0;
  startTunerLoop();
}

function startTunerLoop() {
  stopTunerLoop();
  app._tunerMiss = 0;
  app.tunerTimer = setInterval(tunerDetect, 85);
}
function stopTunerLoop() {
  if (app.tunerTimer) { clearInterval(app.tunerTimer); app.tunerTimer = null; }
}

function tunerDetect() {
  if (!app.tunerAnalyser) return;
  const buf = new Float32Array(app.tunerAnalyser.fftSize);
  app.tunerAnalyser.getFloatTimeDomainData(buf);
  const freq = autoCorrelate(buf, app.ctx.sampleRate);
  const disp = $('#tunerDisplay');
  if (freq <= 0) {
    if (++app._tunerMiss > 6) {
      app.tunerSmooth = 0;
      $('#tunerFreq').textContent = 'play a note…';
      disp.classList.remove('in-tune', 'flat', 'sharp');
    }
    return;
  }
  app._tunerMiss = 0;
  app.tunerSmooth = app.tunerSmooth ? app.tunerSmooth * 0.6 + freq * 0.4 : freq;
  const f = app.tunerSmooth;
  const note = noteFromPitch(f);
  const cents = centsOff(f, note);
  const octave = Math.floor(note / 12) - 1;
  $('#tunerNote').innerHTML = `${NOTE_NAMES[((note % 12) + 12) % 12]}<sub>${octave}</sub>`;
  $('#tunerFreq').textContent = `${f.toFixed(1)} Hz · ${cents >= 0 ? '+' : ''}${cents}¢`;
  $('#tunerNeedle').style.left = clamp(50 + cents, 1, 99) + '%';
  disp.classList.toggle('in-tune', Math.abs(cents) <= 5);
  disp.classList.toggle('flat', cents < -5);
  disp.classList.toggle('sharp', cents > 5);
}

/* ---------------- transport ---------------- */

function stopSources() {
  if (!app.sources.length) return;
  if (app.ctx && app.master) {
    // brief master duck so stopping/seeking doesn't pop
    const now = app.ctx.currentTime;
    app.master.gain.cancelScheduledValues(now);
    app.master.gain.setTargetAtTime(0.0001, now, 0.004);
    app.master.gain.setTargetAtTime(1, now + 0.05, 0.012);
    for (const s of app.sources) { try { s.stop(now + 0.03); } catch (_) {} }
  } else {
    for (const s of app.sources) { try { s.stop(); } catch (_) {} }
  }
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
  if (app.loop && hasLoopRegion() && (app.pos < loopStart() - 0.001 || app.pos >= loopEnd() - 0.01)) {
    app.pos = loopStart();
  } else if (app.pos >= songLength() - 0.25) {
    app.pos = 0;
  }
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
    app.nextTick = Math.ceil(app.pos / secPerTick() - 1e-6);
  }
  drawPlayheads();
  updateTimeUI();
}

/* ---------------- loop region (A/B) ---------------- */

const hasLoopRegion = () => app.loopA != null || app.loopB != null;
const loopStart = () => clamp(app.loopA != null ? app.loopA : 0, 0, songLength());
const loopEnd = () => clamp(app.loopB != null ? app.loopB : songLength(), 0, songLength());

function updateLoopBar() {
  const bar = $('#loopBar');
  if (!bar) return;
  bar.hidden = !app.loop;
  $('#loopAVal').textContent = app.loopA != null ? fmtTime(app.loopA, true) : 'start';
  $('#loopBVal').textContent = app.loopB != null ? fmtTime(app.loopB, true) : 'end';
  $('#loopClear').disabled = !hasLoopRegion();
}

function updateLoopRegionUI() {
  const total = songLength();
  const show = app.loop && hasLoopRegion() && total > 0;
  const a = show ? loopStart() / total : 0;
  const b = show ? loopEnd() / total : 0;
  for (const t of app.tracks) {
    const el = t.ui.loopRegion;
    if (!el) continue;
    el.hidden = !show;
    if (show) { el.style.left = `${a * 100}%`; el.style.width = `${(b - a) * 100}%`; }
  }
}

function setLoopA() {
  if (!songLength()) return;
  app.loopA = clamp(app.pos, 0, songLength());
  if (app.loopB != null && app.loopA >= app.loopB) app.loopB = null;
  updateLoopBar(); updateLoopRegionUI(); saveSettingsSoon();
}
function setLoopB() {
  if (!songLength()) return;
  const b = clamp(app.pos, 0, songLength());
  if (b <= loopStart() + 0.05) { toast('Move the playhead past A first'); return; }
  app.loopB = b;
  updateLoopBar(); updateLoopRegionUI(); saveSettingsSoon();
}
function clearLoopRegion() {
  app.loopA = app.loopB = null;
  updateLoopBar(); updateLoopRegionUI(); saveSettingsSoon();
}

/* ---------------- metronome ---------------- */

const secPerBeat = () => 60 / app.bpm;
const secPerTick = () => secPerBeat() / app.subdiv;

// level: 2 = bar downbeat, 1 = beat, 0 = subdivision
function tickLevel(tickIdx) {
  const ticksPerBar = app.subdiv * app.beatsPerBar;
  const inBar = ((tickIdx % ticksPerBar) + ticksPerBar) % ticksPerBar;
  if (inBar === 0) return 2;
  return (((tickIdx % app.subdiv) + app.subdiv) % app.subdiv === 0) ? 1 : 0;
}

function click(atTime, level = 1) {
  const ctx = app.ctx;
  const osc = ctx.createOscillator();
  const g = ctx.createGain();
  osc.frequency.value = level >= 2 ? 1568 : level === 1 ? 1046 : 784;
  const vol = app.metVol * (level >= 2 ? 0.5 : level === 1 ? 0.32 : 0.15);
  g.gain.setValueAtTime(0.0001, atTime);
  g.gain.exponentialRampToValueAtTime(vol + 0.0001, atTime + 0.002);
  g.gain.exponentialRampToValueAtTime(0.0001, atTime + 0.055);
  osc.connect(g); g.connect(ctx.destination);
  osc.start(atTime); osc.stop(atTime + 0.07);
}

function startBeatScheduler() {
  stopBeatScheduler();
  app.nextTick = Math.ceil(app.playStartPos / secPerTick() - 1e-6);
  app.schedTimer = setInterval(() => {
    // Metronome button is the master switch. While recording, it also has to
    // be armed for the take (metRec) — turning the metronome off always stops
    // the click, even mid-record. (Count-in is separate and still plays.)
    const wantClicks = app.state === 'playing' ? app.met
      : app.state === 'recording' ? (app.met && app.metRec) : false;
    if (!wantClicks) { app.nextTick = Math.ceil(currentPos() / secPerTick()); return; }
    const horizon = app.ctx.currentTime + 0.14;
    while (true) {
      const tickPos = app.nextTick * secPerTick();
      const tickCtx = app.playStartCtx + (tickPos - app.playStartPos);
      if (tickCtx > horizon) break;
      if (tickCtx >= app.ctx.currentTime - 0.01) click(tickCtx, tickLevel(app.nextTick));
      app.nextTick++;
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
    audio: { channelCount: 1, echoCancellation: false, noiseSuppression: false, autoGainControl: false },
  });
  const ctx = app.ctx;
  app.micSourceNode = ctx.createMediaStreamSource(app.micStream);

  // Force mono (channel 0) so a device that only feeds the left channel still
  // records centered instead of left-only. Route through an input-gain node so
  // "mic sensitivity" can boost quiet inputs, and record THAT stream.
  app.recMono = ctx.createGain();
  app.recMono.channelCountMode = 'explicit';
  app.recMono.channelCount = 1;
  app.recMono.channelInterpretation = 'discrete';
  app.recInputGain = ctx.createGain();
  app.recInputGain.gain.value = app.prefs.micGain ?? 1;
  app.recDest = ctx.createMediaStreamDestination();
  app.micAnalyser = ctx.createAnalyser();
  app.micAnalyser.fftSize = 1024;

  app.micSourceNode.connect(app.recMono);
  app.recMono.connect(app.recInputGain);
  app.recInputGain.connect(app.recDest);      // captured by MediaRecorder
  app.recInputGain.connect(app.micAnalyser);  // meter reflects sensitivity
  return app.micStream;
}

function applyMicGain() {
  const g = app.prefs.micGain ?? 1;
  if (app.recInputGain) app.recInputGain.gain.setTargetAtTime(g, app.ctx.currentTime, 0.02);
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
  // Input monitor (if on) deliberately keeps running into the take — that's
  // the point of turning it on. It's a separate tap off the mic node, so it
  // doesn't touch what gets recorded; the only risk is acoustic feedback if
  // you're not on headphones, which we warn about when it's switched on.
  ensureCtx();

  if (!navigator.mediaDevices || !window.MediaRecorder) {
    toast('Recording is not supported in this browser'); return;
  }
  try { await getMic(); }
  catch (_) { toast('Microphone access is needed to record'); return; }

  const mime = pickMime();
  app.recChunks = [];
  app.recorder = new MediaRecorder(app.recDest.stream, mime ? { mimeType: mime } : undefined);
  app.recorder.ondataavailable = (e) => { if (e.data && e.data.size) app.recChunks.push(e.data); };
  app.recorder.onstop = () => finalizeTake(i);
  app.recDiscard = false;

  const started = new Promise((res) => { app.recorder.onstart = res; });
  app.recorder.start();
  await started;
  app.recStartCtx = app.ctx.currentTime;

  const countInDur = app.countIn ? app.beatsPerBar * secPerBeat() : 0;
  const t0 = app.ctx.currentTime + 0.18 + countInDur;
  if (app.countIn) {
    for (let b = 0; b < app.beatsPerBar; b++) click(t0 - countInDur + b * secPerBeat(), b === 0 ? 2 : 1);
  }

  app.recStartPos = app.pos;
  app.recT0 = t0;
  app.recTrack = i;
  app.livePeaks = [];
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
  if (app.recDiscard || !chunks.length || trackIdx !== i) { redrawAllWaves(); return; }

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
    if (keep < sr * 0.12) { toast('Take was too short'); redrawAllWaves(); return; }

    // Store as mono so it always plays centered (never left-only), and de-click
    // the edges with short ~6ms fades. Prefer channel 0; fall back to whichever
    // channel actually carries signal if ch0 is silent.
    const pad = Math.floor(app.recStartPos * sr);
    const out = app.ctx.createBuffer(1, pad + keep, sr);
    const d = out.getChannelData(0);
    let srcCh = raw.getChannelData(0);
    if (raw.numberOfChannels > 1) {
      const e0 = channelEnergy(raw.getChannelData(0));
      const e1 = channelEnergy(raw.getChannelData(1));
      if (e1 > e0 * 4) srcCh = raw.getChannelData(1);   // signal was on the other channel
    }
    d.set(srcCh.subarray(trim), pad);
    const fadeN = Math.min(Math.floor(sr * 0.006), keep >> 1);
    for (let k = 0; k < fadeN; k++) {
      const gn = k / fadeN;
      d[pad + k] *= gn;
      d[pad + keep - 1 - k] *= gn;
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

function channelEnergy(d) {
  let s = 0;
  const step = Math.max(1, Math.floor(d.length / 4000));
  for (let i = 0; i < d.length; i += step) s += Math.abs(d[i]);
  return s;
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
  updateLoopRegionUI();
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
    if (app.state === 'playing' && total) {
      const end = app.loop ? Math.min(loopEnd(), total) : total;
      if (app.pos >= end - 0.001) {
        if (app.loop) { seek(loopStart()); }
        else { stopSources(); stopBeatScheduler(); app.state = 'idle'; app.pos = total; releaseWakeLock(); updateTransportUI(); }
      }
    }
    updateTimeUI();
    drawPlayheads();
    updateMeter();
    if (app.state === 'recording') {
      drawLiveWave();
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
  if (app.pos > app.recStartPos) app.livePeaks.push({ p: app.pos, v: peak });
}

/* Live waveform on the armed track while recording — draw what the mic hears. */
function drawLiveWave() {
  const i = app.recTrack;
  if (i < 0) return;
  const t = app.tracks[i];
  const wrap = t.ui.waveWrap, canvas = t.ui.canvas;
  const dpr = window.devicePixelRatio || 1;
  const w = wrap.clientWidth, h = wrap.clientHeight;
  if (!w) return;
  if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
    canvas.width = w * dpr; canvas.height = h * dpr;
  }
  const g = canvas.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, w, h);
  t.ui.hint.style.display = 'none';
  const during = Math.max(songLength(), currentPos(), 1);
  const barW = 2, gap = 1;
  const buckets = Math.max(1, Math.floor(w / (barW + gap)));
  const acc = new Float32Array(buckets);
  for (const e of app.livePeaks) {
    const b = Math.min(buckets - 1, Math.floor((e.p / during) * buckets));
    if (e.v > acc[b]) acc[b] = e.v;
  }
  const mid = h / 2;
  g.fillStyle = 'rgba(255, 59, 48, 0.8)';
  for (let b = 0; b < buckets; b++) {
    if (!acc[b]) continue;
    const amp = Math.max(1, acc[b] * (h * 0.86)) / 2;
    g.fillRect(b * (barW + gap), mid - amp, barW, amp * 2);
  }
}

/* ---------------- export ---------------- */

async function exportMix() {
  if (app.state === 'recording') { toast('Stop recording first'); return; }
  const total = songLength();
  if (!total) { toast('Nothing to export yet'); return; }
  ensureCtx();
  toast('Rendering mix…');
  const sr = app.ctx.sampleRate;
  const solo = anySolo();
  const off = new OfflineAudioContext(2, Math.ceil(total * sr), sr);

  // master bus mirrors live routing: tracks -> bus -> [lofi] -> destination
  let busOut = off.destination;
  if (app.lofi) {
    const lofi = buildLoFiChain(off, app.lofiAmt);
    lofi.output.connect(off.destination);
    busOut = lofi.input;
  }

  for (const t of app.tracks) {
    if (!t.buffer || t.muted || (solo && !t.solo)) continue;
    const src = off.createBufferSource();
    src.buffer = t.buffer;
    const g = off.createGain(); g.gain.value = t.volume;
    const low = off.createBiquadFilter(); low.type = 'lowshelf'; low.frequency.value = 320; low.gain.value = -13 * (t.tone || 0);
    const high = off.createBiquadFilter(); high.type = 'highshelf'; high.frequency.value = 3200; high.gain.value = 13 * (t.tone || 0);
    src.connect(g); g.connect(low); low.connect(high);
    if (off.createStereoPanner) {
      const p = off.createStereoPanner(); p.pan.value = t.pan;
      high.connect(p); p.connect(busOut);
    } else high.connect(busOut);
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
  app.exportBlob = new Blob([wav], { type: 'audio/wav' });
  app.exportName = name;
  openExportSheet(`${name}.wav`);
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}

async function shareFile(blob, filename, title) {
  const file = new File([blob], filename, { type: blob.type });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try { await navigator.share({ files: [file], title }); return true; }
    catch (e) { if (e && e.name === 'AbortError') return true; }   // user cancelled
  }
  return false;
}

/* result sheet: choose Share (native sheet) or Save (download) */
function openExportSheet(filename) {
  $('#exportFilename').textContent = filename;
  const file = app.exportBlob && new File([app.exportBlob], filename, { type: 'audio/wav' });
  const canShare = !!(navigator.canShare && file && navigator.canShare({ files: [file] }));
  $('#expShare').hidden = !canShare;
  closeSheets();
  $('#exportSheet').hidden = false;
}

/* ---------------- project backup / import ---------------- */

function abToBase64(ab) {
  const bytes = new Uint8Array(ab);
  let bin = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  return btoa(bin);
}
function base64ToAb(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes.buffer;
}

async function backupProject() {
  if (!app.projectId) return;
  await saveSettings();
  const data = { format: '4track', v: 1, exported: Date.now(), settings: currentSettings(), audio: [] };
  for (let i = 0; i < NUM_TRACKS; i++) {
    const t = app.tracks[i];
    data.audio[i] = t.buffer ? abToBase64(bufferToWav(t.buffer, false)) : null;   // 16-bit for portable size
  }
  const name = (data.settings.projectName || 'project').replace(/[^\w\- ]+/g, '').trim() || 'project';
  const blob = new Blob([JSON.stringify(data)], { type: 'application/json' });
  const shared = await shareFile(blob, `${name}.4track.json`, name);
  if (!shared) downloadBlob(blob, `${name}.4track.json`);
  toast('Project backed up');
}

async function importProjectFile(file) {
  let data;
  try { data = JSON.parse(await file.text()); }
  catch (_) { toast('Could not read that file'); return; }
  if (!data || data.format !== '4track') { toast('Not a 4track backup'); return; }

  const id = newProjectId();
  const s = data.settings || {};
  await idb.set(projKey(id, 'settings'), s);
  for (let i = 0; i < NUM_TRACKS; i++) {
    const b64 = data.audio && data.audio[i];
    if (b64) await idb.set(projKey(id, `audio${i}`), { sr: 0, wav: base64ToAb(b64) });
  }
  app.projectsMeta.push({
    id, name: s.projectName || 'Imported', updated: Date.now(),
    length: 0, bpm: s.bpm || 120,
  });
  await idb.set('projects', app.projectsMeta);
  closeSheets();
  await openProject(id);
  toast(`Imported “${$('#projectName').value}”`);
}

/* ---------------- media session (lock screen / headphone remote) ---------------- */

function setupMediaSession() {
  if (!('mediaSession' in navigator)) return;
  const set = (action, fn) => { try { navigator.mediaSession.setActionHandler(action, fn); } catch (_) {} };
  set('play', () => { if (app.state === 'idle') play(); });
  set('pause', () => stopAll());
  set('stop', () => stopAll());
  set('previoustrack', () => seek(0));
  set('seekbackward', () => seek(Math.max(0, app.pos - 5)));
  set('seekforward', () => seek(Math.min(songLength(), app.pos + 5)));
}

function updateMediaSession() {
  if (!('mediaSession' in navigator)) return;
  try {
    navigator.mediaSession.playbackState = app.state === 'idle' ? 'paused' : 'playing';
    navigator.mediaSession.metadata = new MediaMetadata({
      title: ($('#projectName') && $('#projectName').value) || 'Untitled',
      artist: '4track',
      album: 'Demo',
      artwork: [{ src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png' }],
    });
  } catch (_) {}
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
    loopA: app.loopA, loopB: app.loopB,
    beatsPerBar: app.beatsPerBar, subdiv: app.subdiv,
    lofi: app.lofi, lofiAmt: app.lofiAmt,
    tracks: app.tracks.map(t => ({ name: t.name, volume: t.volume, pan: t.pan, muted: t.muted, solo: t.solo, tone: t.tone })),
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
  app.loopA = (s && s.loopA != null) ? s.loopA : null;
  app.loopB = (s && s.loopB != null) ? s.loopB : null;
  app.beatsPerBar = clamp((s && s.beatsPerBar) || 4, 2, 12);
  app.subdiv = clamp((s && s.subdiv) || 1, 1, 4);
  app.lofi = !!(s && s.lofi);
  app.lofiAmt = (s && s.lofiAmt) ?? 0.8;
  ((s && s.tracks) || []).forEach((m, i) => {
    if (!app.tracks[i]) return;
    Object.assign(app.tracks[i], {
      name: m.name, volume: m.volume, pan: m.pan, muted: m.muted,
      solo: !!m.solo, tone: m.tone || 0,
    });
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
    if (!s || !s.tracks || !s.tracks[i]) Object.assign(t, { name: `Track ${i + 1}`, volume: 0.9, pan: 0, muted: false, solo: false, tone: 0 });
    if (t.gainNode) { applyTrackGain(t); applyTone(t); }
    refreshTrack(i);
  }
  if (app.ctx) rebuildLoFi();
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
    Object.assign(t, { name: `Track ${i + 1}`, volume: 0.9, pan: 0, muted: false, solo: false, tone: 0 });
    if (t.gainNode) { applyTrackGain(t); applyTone(t); }
    refreshTrack(i);
  }
  if (app.ctx) rebuildLoFi();
  app.prefs.lastProject = app.projectId;
  savePrefs();
  await saveSettings();
  syncSettingsUI();
  updateTransportUI();
  redrawAllWaves();
  drawPlayheads();
  if (!quiet) toast('New project');
}

/* Two-tap confirm: first tap arms the button for a moment, second tap fires.
   Friendlier than confirm() dialogs, which look foreign in a standalone PWA. */
function armConfirm(btn, armedLabel, fn, restore) {
  let timer = null;
  const original = restore || (() => { btn.textContent = btn.dataset.label; });
  btn.dataset.label = btn.dataset.label || btn.textContent;
  btn.addEventListener('click', () => {
    if (btn.classList.contains('armed')) {
      clearTimeout(timer);
      btn.classList.remove('armed');
      original();
      fn();
      return;
    }
    btn.classList.add('armed');
    btn.textContent = armedLabel;
    timer = setTimeout(() => { btn.classList.remove('armed'); original(); }, 2600);
  });
}

async function deleteProject(id) {
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
    const delBtn = $('.proj-del', row);
    const trashIcon = delBtn.innerHTML;
    armConfirm(delBtn, 'Sure?', () => deleteProject(m.id), () => { delBtn.innerHTML = trashIcon; });
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
      name: `Track ${i + 1}`, volume: 0.9, pan: 0, muted: false, solo: false, tone: 0,
      gainNode: null, panNode: null, toneLow: null, toneHigh: null, ui: {},
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
          <span class="badge-solo" hidden>solo</span>
          <span class="badge-mute" hidden>muted</span>
          <span class="badge-tone" hidden></span>
          <span class="track-dur"></span>
          <svg class="chev" viewBox="0 0 24 24" width="15" height="15"><path fill="currentColor" d="M9 6l6 6-6 6" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>
        </div>
        <div class="wave-wrap">
          <canvas></canvas>
          <div class="loop-region" hidden></div>
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
      loopRegion: $('.loop-region', el),
      hint: $('.wave-hint', el),
      playhead: $('.playhead', el),
      meter: $('.meter', el),
      recBtn: $('.rec-btn', el),
      title: $('.track-title', el),
      badgeSolo: $('.badge-solo', el),
      badgeMute: $('.badge-mute', el),
      badgeTone: $('.badge-tone', el),
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
      if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); openTrackSheet(i); }
    });
  }

  const ro = new ResizeObserver(() => { redrawAllWaves(); drawPlayheads(); });
  ro.observe(host);
}

function refreshTrack(i) {
  const t = app.tracks[i];
  t.ui.title.textContent = t.name || `Track ${i + 1}`;
  t.ui.badgeSolo.hidden = !t.solo;
  t.ui.badgeMute.hidden = !t.muted;
  const tv = Math.round((t.tone || 0) * 100);
  t.ui.badgeTone.hidden = tv === 0;
  t.ui.badgeTone.textContent = tv > 0 ? `+${tv} bright` : `${tv} dark`;
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
  updateLoopBar();
  updateLoopRegionUI();
  updateMediaSession();
}

function updateTimeUI() {
  const el = $('#timeDisplay');
  const s = app.state === 'idle' ? app.pos : currentPos();
  el.innerHTML = `${fmtTime(s)}<span class="time-frac">.${Math.floor((Math.max(0, s) % 1) * 10)}</span>`;
  const total = songLength();
  $('#lengthDisplay').textContent = total ? `of ${fmtTime(total)} · ${app.bpm} bpm` : 'ready to record';
}

/* ---------------- sheets ---------------- */

function markLoFiPreset() {
  for (const b of document.querySelectorAll('#lofiPresets .seg-btn')) {
    b.setAttribute('aria-pressed', String(Math.abs(+b.dataset.amt - app.lofiAmt) < 0.02));
  }
}

function syncSettingsUI() {
  $('#setSpeakerBoost').checked = !!app.prefs.speakerBoost;
  $('#setLoFi').checked = app.lofi;
  $('#setLoFiAmt').value = Math.round(app.lofiAmt * 100);
  $('#lofiAmtLabel').textContent = `${Math.round(app.lofiAmt * 100)}%`;
  markLoFiPreset();
  $('#setMicGain').value = Math.round((app.prefs.micGain ?? 1) * 100);
  $('#micGainLabel').textContent = `${Math.round((app.prefs.micGain ?? 1) * 100)}%`;
  $('#setCountIn').checked = app.countIn;
  $('#setMetRec').checked = app.metRec;
  $('#setMetVol').value = Math.round(app.metVol * 100);
  $('#setLatency').value = app.latencyMs;
  $('#latencyLabel').textContent = `auto ${app.latencyMs >= 0 ? '+' : '−'} ${Math.abs(app.latencyMs)} ms`;
  $('#beatsVal').textContent = String(app.beatsPerBar);
  $('#timeSigLabel').textContent = `${app.beatsPerBar} / ${app.subdiv >= 2 ? 8 : 4}`;
  for (const b of document.querySelectorAll('#subdivRow .seg-btn')) {
    b.setAttribute('aria-pressed', String(+b.dataset.sub === app.subdiv));
  }
  updateLoFiBadge();
}

function updateLoFiBadge() {
  const b = $('#lofiBadge');
  if (b) b.hidden = !app.lofi;
}

function closeSheets() {
  stopMonitorMeter();   // the level bar lives in the track sheet; stop animating it once hidden
  stopTunerLoop();
  $('#settingsSheet').hidden = true;
  $('#projectsSheet').hidden = true;
  $('#trackSheet').hidden = true;
  $('#exportSheet').hidden = true;
  $('#tunerSheet').hidden = true;
}

/* ---- per-track options sheet ---- */

function panLabel(pan) {
  const p = Math.round(pan * 100);
  if (p === 0) return 'center';
  return `${Math.abs(p)}% ${p < 0 ? 'left' : 'right'}`;
}
function toneLabel(v) {
  const p = Math.round(v * 100);
  if (p === 0) return 'flat';
  return p > 0 ? `+${p} bright` : `${p} dark`;
}

function drawSheetWave(i) {
  const t = app.tracks[i];
  const canvas = $('#tsWave');
  const scroll = $('#tsWaveScroll');
  const dpr = window.devicePixelRatio || 1;
  const baseW = scroll.clientWidth || 300;
  const h = 88;
  const cssW = Math.max(baseW, Math.round(baseW * app.sheetZoom));
  canvas.style.width = cssW + 'px';
  canvas.style.height = h + 'px';
  canvas.width = cssW * dpr;
  canvas.height = h * dpr;
  const g = canvas.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, cssW, h);
  const mid = h / 2;
  if (!t.buffer) {
    g.fillStyle = waveInk; g.globalAlpha = 0.4;
    g.font = '12px -apple-system, system-ui, sans-serif'; g.textAlign = 'center';
    g.fillText('no audio yet', cssW / 2, mid + 4); g.globalAlpha = 1;
    return;
  }
  const barW = 2, gap = 1;
  const buckets = Math.max(1, Math.floor(cssW / (barW + gap)));
  const peaks = computePeaks(t.buffer, buckets);
  g.fillStyle = waveInk;
  for (let b = 0; b < buckets; b++) {
    const amp = Math.max(1, peaks[b] * (h * 0.86)) / 2;
    const x = b * (barW + gap);
    if (g.roundRect) { g.beginPath(); g.roundRect(x, mid - amp, barW, amp * 2, 1); g.fill(); }
    else g.fillRect(x, mid - amp, barW, amp * 2);
  }
}

function setSheetZoom(z) {
  app.sheetZoom = clamp(z, 1, 16);
  $('#tsZoomLabel').textContent = `${Math.round(app.sheetZoom * 10) / 10}×`;
  if (app.sheetTrack >= 0) drawSheetWave(app.sheetTrack);
}

function syncTrackSheet(i) {
  const t = app.tracks[i];
  $('#tsNum').textContent = String(i + 1);
  if (document.activeElement !== $('#tsName')) $('#tsName').value = t.name;
  $('#tsDur').textContent = t.buffer ? fmtTime(t.buffer.duration) : 'empty';
  $('#tsVol').value = Math.round(t.volume * 100);
  $('#tsVolLabel').textContent = `${Math.round(t.volume * 100)}%`;
  $('#tsPan').value = Math.round(t.pan * 100);
  $('#tsPanLabel').textContent = panLabel(t.pan);
  $('#tsTone').value = Math.round((t.tone || 0) * 100);
  $('#tsToneLabel').textContent = toneLabel(t.tone || 0);
  $('#tsSolo').checked = t.solo;
  $('#tsMute').checked = t.muted;
  $('#tsMonitor').checked = !!app.monitorGain;
  $('#tsUndo').disabled = t.prevBuffer === undefined;
  $('#tsClear').disabled = !t.buffer;
}

function openTrackSheet(i) {
  app.sheetTrack = i;
  app.sheetZoom = 1;
  syncTrackSheet(i);
  $('#tsZoomLabel').textContent = '1×';
  $('#settingsSheet').hidden = true;
  $('#projectsSheet').hidden = true;
  $('#trackSheet').hidden = false;
  requestAnimationFrame(() => drawSheetWave(i));
  if (app.monitorGain) startMonitorMeter();   // resume the level bar if monitor's already on
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
    $('#tsVolLabel').textContent = `${Math.round(t.volume * 100)}%`;
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
  $('#tsTone').addEventListener('input', () => {
    const t = cur(); if (!t) return;
    t.tone = $('#tsTone').value / 100;
    $('#tsToneLabel').textContent = toneLabel(t.tone);
    if (app.ctx) applyTone(t);
    refreshTrack(app.sheetTrack); saveSettingsSoon();
  });
  $('#tsSolo').addEventListener('change', () => {
    const t = cur(); if (!t) return;
    t.solo = $('#tsSolo').checked;
    applyAllGains();
    for (let i = 0; i < NUM_TRACKS; i++) refreshTrack(i);
    saveSettingsSoon();
  });
  $('#tsMute').addEventListener('change', () => {
    const t = cur(); if (!t) return;
    t.muted = $('#tsMute').checked;
    applyAllGains();
    refreshTrack(app.sheetTrack); saveSettingsSoon();
  });
  $('#tsMonitor').addEventListener('change', (e) => setMonitor(e.target.checked));
  $('#tsZoomIn').addEventListener('click', () => setSheetZoom(app.sheetZoom * 1.7));
  $('#tsZoomOut').addEventListener('click', () => setSheetZoom(app.sheetZoom / 1.7));
  $('#tsUndo').addEventListener('click', () => {
    const t = cur(); if (!t || t.prevBuffer === undefined) return;
    [t.buffer, t.prevBuffer] = [t.prevBuffer, t.buffer];
    refreshTrack(app.sheetTrack); redrawAllWaves(); drawSheetWave(app.sheetTrack);
    saveTrackAudio(app.sheetTrack); saveSettingsSoon();
    toast(t.buffer ? 'Previous take restored' : 'Take removed — Undo again to bring it back');
  });
  $('#tsClear').addEventListener('click', () => {
    const t = cur(); if (!t || !t.buffer) return;
    t.prevBuffer = t.buffer;
    t.buffer = null;
    refreshTrack(app.sheetTrack); redrawAllWaves(); drawSheetWave(app.sheetTrack);
    saveTrackAudio(app.sheetTrack); saveSettingsSoon();
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
  $('#tunerBtn').addEventListener('click', openTuner);
  $('#tunerDone').addEventListener('click', closeSheets);
  $('#closeSettingsBtn').addEventListener('click', closeSheets);
  for (const id of ['settingsSheet', 'projectsSheet', 'tunerSheet']) {
    $(`#${id}`).addEventListener('click', (e) => { if (e.target === $(`#${id}`)) closeSheets(); });
  }
  $('#newProjectBtn').addEventListener('click', async () => {
    closeSheets();
    await createProject();
  });
  $('#setSpeakerBoost').addEventListener('change', (e) => {
    app.prefs.speakerBoost = e.target.checked;
    if (app.prefs.speakerBoost) ensureCtx();
    if (app.ctx) rebuildOutputStage();
    savePrefs();
    toast(app.prefs.speakerBoost ? 'Speaker boost on' : 'Speaker boost off');
  });
  $('#setLoFi').addEventListener('change', (e) => {
    app.lofi = e.target.checked;
    if (app.lofi) ensureCtx();
    rebuildLoFi(); updateLoFiBadge(); saveSettingsSoon();
    toast(app.lofi ? 'Lo-Fi on' : 'Lo-Fi off');
  });
  $('#setLoFiAmt').addEventListener('input', (e) => {
    app.lofiAmt = e.target.value / 100;
    $('#lofiAmtLabel').textContent = `${Math.round(app.lofiAmt * 100)}%`;
    markLoFiPreset();
    if (app.lofi) rebuildLoFi();
    saveSettingsSoon();
  });
  for (const b of document.querySelectorAll('#lofiPresets .seg-btn')) {
    b.addEventListener('click', () => {
      app.lofiAmt = +b.dataset.amt;
      app.lofi = true;
      ensureCtx();
      syncSettingsUI(); rebuildLoFi(); updateLoFiBadge(); saveSettingsSoon();
      toast(`Lo-Fi — ${b.textContent}`);
    });
  }
  $('#setMicGain').addEventListener('input', (e) => {
    app.prefs.micGain = +e.target.value / 100;
    $('#micGainLabel').textContent = `${e.target.value}%`;
    applyMicGain(); savePrefs();
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
  const setBeats = (v) => { app.beatsPerBar = clamp(v, 2, 12); syncSettingsUI(); saveSettingsSoon(); };
  $('#beatsDown').addEventListener('click', () => setBeats(app.beatsPerBar - 1));
  $('#beatsUp').addEventListener('click', () => setBeats(app.beatsPerBar + 1));
  for (const b of document.querySelectorAll('#subdivRow .seg-btn')) {
    b.addEventListener('click', () => {
      app.subdiv = clamp(+b.dataset.sub, 1, 4);
      syncSettingsUI(); saveSettingsSoon();
      if (app.met || app.state !== 'idle') { ensureCtx(); click(app.ctx.currentTime + 0.01, 1); }
    });
  }
  $('#backupBtn').addEventListener('click', backupProject);
  $('#importBtn').addEventListener('click', () => $('#importFile').click());
  $('#importFile').addEventListener('change', (e) => {
    const f = e.target.files && e.target.files[0];
    e.target.value = '';
    if (f) importProjectFile(f);
  });
  armConfirm($('#deleteProjectBtn'), 'Tap again to delete', () => {
    closeSheets();
    deleteProject(app.projectId);
  });

  // export result sheet
  $('#expSave').addEventListener('click', () => {
    if (app.exportBlob) downloadBlob(app.exportBlob, `${app.exportName}.wav`);
    closeSheets();
  });
  $('#expShare').addEventListener('click', async () => {
    if (!app.exportBlob) return;
    const ok = await shareFile(app.exportBlob, `${app.exportName}.wav`, app.exportName);
    if (!ok) downloadBlob(app.exportBlob, `${app.exportName}.wav`);
    closeSheets();
  });
  $('#expDone').addEventListener('click', closeSheets);
  $('#exportSheet').addEventListener('click', (e) => { if (e.target === $('#exportSheet')) closeSheets(); });
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
  $('#loopSetA').addEventListener('click', setLoopA);
  $('#loopSetB').addEventListener('click', setLoopB);
  $('#loopClear').addEventListener('click', clearLoopRegion);
  $('#metBtn').addEventListener('click', () => {
    app.met = !app.met;
    if (app.met) { ensureCtx(); click(app.ctx.currentTime + 0.01, 2); }
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
    click(app.ctx.currentTime + 0.01, 1);
  });
  $('#exportBtn').addEventListener('click', exportMix);
  $('#projectName').addEventListener('input', updateMediaSession);
  $('#lofiBadge').addEventListener('click', () => {
    app.lofi = false;
    rebuildLoFi(); updateLoFiBadge(); syncSettingsUI(); saveSettingsSoon();
    toast('Lo-Fi off');
  });
  $('#monitorBadge').addEventListener('click', () => setMonitor(!app.monitorGain));
  $('#projectName').addEventListener('input', saveSettingsSoon);
}

/* ---------------- keyboard ---------------- */

const anySheetOpen = () =>
  ['settingsSheet', 'projectsSheet', 'trackSheet', 'exportSheet'].some(id => !$(`#${id}`).hidden);

function wireKeyboard() {
  window.addEventListener('keydown', (e) => {
    if (e.target.matches('input[type="text"], input:not([type]), [contenteditable]')) return;
    if (e.repeat) return;
    if (anySheetOpen() && e.key !== 'Escape') return;   // don't record/export behind a sheet
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

// don't let a take vanish because the tab closed mid-recording
window.addEventListener('beforeunload', (e) => {
  if (app.state === 'recording') { e.preventDefault(); e.returnValue = ''; }
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
  $('#versionTag').textContent = `v${APP_VERSION} · © Avery`;
  $('#versionHint').textContent = `4track v${APP_VERSION} · © Avery`;
  buildTracks();
  buildAppearancePickers();
  wireTransport();
  wireSheets();
  wireTrackSheet();
  wireKeyboard();
  setupMediaSession();
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
  if (app.ctx) rebuildOutputStage();   // in the rare case audio started before prefs loaded

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
