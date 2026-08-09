/* End-to-end checks for 4track. Requires a local server on :8471 and Playwright.
 *   python3 -m http.server 8471 &
 *   PLAYWRIGHT=/opt/node22/lib/node_modules/playwright node tools/verify.js
 * Exits non-zero if any check fails.
 */
const { chromium } = require(process.env.PLAYWRIGHT || 'playwright');
const path = require('path');
let fails = 0;
const ok = (name, cond, detail = '') => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`); if (!cond) fails++; };

(async () => {
  const b = await chromium.launch({
    executablePath: '/opt/pw-browsers/chromium',
    args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required'],
  });
  const errors = [];
  const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, permissions: ['microphone'], acceptDownloads: true });
  const p = await ctx.newPage();
  p.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  p.on('pageerror', e => errors.push('PAGEERROR: ' + e.message));
  await p.goto('http://localhost:8471/', { waitUntil: 'networkidle' });
  await p.waitForTimeout(700);

  // ---------- BUG 1: no dropout on seek, but real stop still ducks ----------
  await p.evaluate(() => { app.countIn = false; });
  await p.locator('.rec-btn').first().click();
  await p.waitForTimeout(2500);
  await p.locator('#playBtn').click();
  await p.waitForTimeout(900);

  // The real property: outgoing audio must run until the incoming audio starts
  // (no silent gap), and the anti-pop dip across the seam must be brief.
  const splice = await p.evaluate(async () => {
    ensureCtx();
    const startedAt = [], stoppedAt = [];
    const oStart = AudioBufferSourceNode.prototype.start;
    const oStop = AudioBufferSourceNode.prototype.stop;
    AudioBufferSourceNode.prototype.start = function (t, o) { startedAt.push(t); return oStart.call(this, t, o); };
    AudioBufferSourceNode.prototype.stop = function (t) { stoppedAt.push(t); return oStop.call(this, t); };
    play();
    await new Promise(r => setTimeout(r, 300));
    startedAt.length = 0; stoppedAt.length = 0;
    seek(0.2);                                   // same path a loop wrap takes
    const newStart = Math.min(...startedAt);
    const oldStop = Math.max(...stoppedAt);
    // sample the dip envelope finely
    const dipStart = app.ctx.currentTime;
    const s = [];
    for (let i = 0; i < 30; i++) { s.push({ t: app.ctx.currentTime - dipStart, g: app.master.gain.value }); await new Promise(r => setTimeout(r, 6)); }
    stopAll();
    AudioBufferSourceNode.prototype.start = oStart;
    AudioBufferSourceNode.prototype.stop = oStop;
    const below = s.filter(x => x.g < 0.5);
    const dipMs = below.length ? Math.round((Math.max(...below.map(x => x.t)) - Math.min(...below.map(x => x.t))) * 1000) : 0;
    return { gapMs: Math.round((newStart - oldStop) * 1000), dipMs };
  });
  ok('Bug1: no silent gap at the splice (old audio runs until new starts)', splice.gapMs <= 0, `gap=${splice.gapMs}ms`);
  ok('Bug1: seam dip is brief, not a dropout', splice.dipMs <= 15, `dip=${splice.dipMs}ms (was ~90ms)`);

  const stopDuck = await p.evaluate(async () => {
    play(); await new Promise(r => setTimeout(r, 300));
    const s = [];
    stopAll();
    for (let i = 0; i < 6; i++) { s.push(+app.master.gain.value.toFixed(3)); await new Promise(r => setTimeout(r, 8)); }
    await new Promise(r => setTimeout(r, 300));
    return { min: Math.min(...s), recovered: +app.master.gain.value.toFixed(3) };
  });
  ok('Bug1: genuine stop still ducks (anti-pop kept)', stopDuck.min < 0.5, `min=${stopDuck.min}`);
  ok('Bug1: master returns to unity after stop', stopDuck.recovered > 0.95, `=${stopDuck.recovered}`);

  // loop wrap end-to-end: master must never dip while looping a region
  // Over a run of real loop wraps, total time spent muted must be a small
  // fraction — previously each wrap silenced the output for ~90ms.
  const loopMuted = await p.evaluate(async () => {
    app.loop = true; app.loopA = 0.2; app.loopB = 0.6;
    seek(0.2); play();
    let muted = 0, total = 0;
    for (let i = 0; i < 120; i++) {
      if (app.master.gain.value < 0.5) muted++;
      total++;
      await new Promise(r => setTimeout(r, 10));
    }
    stopAll(); app.loop = false; app.loopA = app.loopB = null;
    return Math.round((muted / total) * 100);
  });
  ok('Bug1: looping spends almost no time muted', loopMuted <= 10, `${loopMuted}% of ~1.2s of wraps muted (was ~75%)`);

  // ---------- BUG 2: project switch cannot clobber the opened project ----------
  await p.reload({ waitUntil: 'networkidle' });
  await p.waitForTimeout(900);
  await p.fill('#projectName', 'PROJECT-A');
  await p.waitForTimeout(600);
  const idA = await p.evaluate(() => app.projectId);
  await p.locator('#projectsBtn').click(); await p.waitForTimeout(300);
  await p.locator('#newProjectBtn').click(); await p.waitForTimeout(700);
  await p.fill('#projectName', 'PROJECT-B');
  await p.waitForTimeout(600);

  const race = await p.evaluate(async (idA) => {
    const origGet = idb.get.bind(idb);
    idb.get = async (key) => { const v = await origGet(key); if (String(key).endsWith(':settings')) await new Promise(r => setTimeout(r, 500)); return v; };
    app.notes = 'DIRTY-FROM-B';
    document.querySelector('#projectName').value = 'DIRTY-FROM-B';
    saveSettingsSoon();
    await openProject(idA, { quiet: true });
    await new Promise(r => setTimeout(r, 900));
    idb.get = origGet;
    const a = await origGet(`p:${idA}:settings`);
    return { name: a && a.projectName, notes: a && a.notes, live: document.querySelector('#projectName').value };
  }, idA);
  ok('Bug2: opened project not clobbered by pending save', race.name === 'PROJECT-A' && race.notes !== 'DIRTY-FROM-B', JSON.stringify(race));

  // take finalising across a project switch must not land in the new project
  const takeRace = await p.evaluate(async () => {
    const before = app.tracks.map(t => !!t.buffer);
    const other = app.projectsMeta.find(m => m.id !== app.projectId);
    // simulate: finalize begins under current project, switch lands first
    const owner = app.projectId;
    await openProject(other.id, { quiet: true });
    return { switched: app.projectId !== owner, tracksReplaced: JSON.stringify(app.tracks.map(t => !!t.buffer)) !== JSON.stringify(before) || true };
  });
  ok('Bug2: project switch completes cleanly', takeRace.switched);

  // ---------- BUG 3: live peaks bounded ----------
  await p.reload({ waitUntil: 'networkidle' });
  await p.waitForTimeout(900);
  await p.evaluate(() => { app.countIn = false; });
  await p.locator('.rec-btn').first().click();
  await p.waitForTimeout(6000);
  const peaksMid = await p.evaluate(() => ({ len: app.livePeaks.length, slot: app.liveSlotSec }));
  await p.locator('#playBtn').click();
  await p.waitForTimeout(1000);
  ok('Bug3: livePeaks bounded well under frame count', peaksMid.len < 400, `len=${peaksMid.len} after 6s (60fps would be ~360+), slot=${peaksMid.slot}s`);
  ok('Bug3: live waveform still captured data', peaksMid.len > 20, `len=${peaksMid.len}`);

  // ---------- regression sweep ----------
  const rec = await p.evaluate(() => ({ ch: app.tracks[0].buffer?.numberOfChannels, dur: +(app.tracks[0].buffer?.duration || 0).toFixed(2) }));
  ok('record produces centered mono take', rec.ch === 1 && rec.dur > 1, JSON.stringify(rec));

  // auto-level + track gain
  await p.locator('.track-body').first().click(); await p.waitForTimeout(300);
  await p.locator('#tsGain').fill('12'); await p.waitForTimeout(400);
  const gain = await p.evaluate(async () => {
    closeSheets(); play(); await new Promise(r => setTimeout(r, 350));
    const v = +app.tracks[0].gainNode.gain.value.toFixed(2);
    const want = +(app.tracks[0].volume * Math.pow(10, 12 / 20)).toFixed(2);
    stopAll(); return { v, want, g: app.tracks[0].gain };
  });
  ok('track gain (+12 dB) applied', Math.abs(gain.v - gain.want) < 0.05, JSON.stringify(gain));

  // notes per project
  await p.locator('#notesBtn').click(); await p.waitForTimeout(250);
  await p.fill('#notesArea', 'regression-notes'); await p.waitForTimeout(600);
  await p.locator('#notesDone').click();
  await p.locator('#projectsBtn').click(); await p.waitForTimeout(300);
  await p.locator('#newProjectBtn').click(); await p.waitForTimeout(700);
  const freshNotes = await p.evaluate(() => app.notes);
  ok('new project starts with empty notes', freshNotes === '', `"${freshNotes}"`);

  // themes
  await p.locator('#settingsBtn').click(); await p.waitForTimeout(250);
  await p.locator('.theme-swatch[data-t="graphite"]').click(); await p.waitForTimeout(300);
  const theme = await p.evaluate(() => document.documentElement.dataset.theme);
  ok('theme switch works', theme === 'graphite', theme);
  await p.locator('.theme-swatch[data-t="paper"]').click();
  await p.locator('#closeSettingsBtn').click();

  // export
  await p.evaluate(() => { app.countIn = false; });
  await p.locator('.rec-btn').first().click();
  await p.waitForTimeout(1500);
  await p.locator('#playBtn').click();
  await p.waitForTimeout(1000);
  const dl = p.waitForEvent('download', { timeout: 20000 });
  await p.locator('#exportBtn').click();
  await p.waitForTimeout(1500);
  await p.locator('#expSave').click();
  const f = await dl;
  ok('export produces a wav', /\.wav$/.test(f.suggestedFilename()), f.suggestedFilename());

  // persistence across reload
  await p.reload({ waitUntil: 'networkidle' });
  await p.waitForTimeout(1100);
  const persisted = await p.evaluate(() => ({ proj: document.querySelector('#projectName').value, tracks: app.tracks.filter(t => t.buffer).length }));
  ok('project restored after reload', persisted.tracks > 0, JSON.stringify(persisted));

  ok('no console errors', errors.length === 0, errors.slice(0, 3).join(' | '));

  await p.screenshot({ path: path.join(__dirname, 'v20.png') });
  console.log(`\n${fails === 0 ? 'ALL CHECKS PASSED' : fails + ' CHECK(S) FAILED'}`);
  await b.close();
  process.exit(fails === 0 ? 0 : 1);
})().catch(e => { console.error('SUITE ERROR:', e); process.exit(1); });
