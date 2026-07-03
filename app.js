/* =========================================================================
   Polyrhythm Drill — pure vanilla JS + Web Audio API
   No dependencies, no build step. Works from file:// or GitHub Pages.
   ========================================================================= */
(function () {
  'use strict';

  // ---------- State ----------
  const S = {
    mode: 'fixed',            // 'fixed' | 'freestyle'
    ratioL: 3,
    ratioR: 4,
    bpm: 45,
    tempoRef: 'cycle',        // what the BPM counts: 'cycle' | 'left' | 'right'
    metro: true,
    guide: false,
    keyL: 'f',
    keyR: 'j',
    volume: 0.8,
    running: false,
    startPerf: 0,             // performance.now() at start (ms)
    startAudio: 0,            // ctx.currentTime at start (s)
    stopPerf: 0,              // frozen "now" when stopped
    taps: [],                 // {hand:'L'|'R', e:ms since start, off:ms|null, abs:ms}
    binding: null,            // 'L' | 'R' while capturing a key
  };

  const TOL_GOOD = 22;        // ms — green
  const TOL_OK = 55;          // ms — yellow

  // ---------- DOM ----------
  const $ = (id) => document.getElementById(id);
  const el = {
    modeFixed: $('modeFixed'), modeFree: $('modeFree'),
    ratioL: $('ratioL'), ratioR: $('ratioR'), presets: $('presets'),
    bpm: $('bpm'), bpmVal: $('bpmVal'), tempoRef: $('tempoRef'),
    tempoHint: $('tempoHint'), derived: $('derived'),
    metro: $('metro'), guide: $('guide'),
    bindL: $('bindL'), bindR: $('bindR'), keyL: $('keyL'), keyR: $('keyR'), bindMsg: $('bindMsg'),
    volume: $('volume'),
    startBtn: $('startBtn'), clearBtn: $('clearBtn'),
    stageTitle: $('stageTitle'), tapHint: $('tapHint'),
    timeline: $('timeline'), phase: $('phase'),
    stTaps: $('stTaps'), stAvg: $('stAvg'), stIn: $('stIn'), stStreak: $('stStreak'),
    anBody: $('anBody'),
    playTaps: $('playTaps'), playRef: $('playRef'), pbMsg: $('pbMsg'),
    // mobile / PWA
    startBtn2: $('startBtn2'), padL: $('padL'), padR: $('padR'),
    padKeyL: $('padKeyL'), padKeyR: $('padKeyR'),
    installBtn: $('installBtn'), iosHelp: $('iosHelp'), iosClose: $('iosClose'),
  };

  // =========================================================================
  //  Timing math
  // =========================================================================
  // Cycle length in seconds, given ratio + bpm + what the bpm refers to.
  function cycleSec() {
    const beat = 60 / S.bpm;              // seconds per one BPM beat
    if (S.tempoRef === 'left') return beat * S.ratioL;   // bpm = left-hand pulse
    if (S.tempoRef === 'right') return beat * S.ratioR;  // bpm = right-hand pulse
    return beat;                                         // bpm = one full cycle
  }
  const cycleMs = () => cycleSec() * 1000;
  const intervalMs = (hand) => cycleMs() / (hand === 'L' ? S.ratioL : S.ratioR);

  // Nearest reference time (ms since start) + signed offset for a tap.
  function evaluateTap(hand, e) {
    const iv = intervalMs(hand);
    const k = Math.round(e / iv);
    const ref = k * iv;
    const off = e - ref;                 // + = late, - = early
    return { off, abs: Math.abs(off) };
  }

  // =========================================================================
  //  Audio engine
  // =========================================================================
  let ctx = null, master = null;
  function audio() {
    if (ctx) return ctx;
    ctx = new (window.AudioContext || window.webkitAudioContext)();
    master = ctx.createGain();
    master.gain.value = S.volume;
    master.connect(ctx.destination);
    return ctx;
  }

  // A plucked tone with a quick percussive envelope.
  function tone(when, freq, type, gain, dur) {
    const c = audio();
    const o = c.createOscillator();
    const g = c.createGain();
    o.type = type;
    o.frequency.value = freq;
    // tiny pitch drop for a more "struck" feel
    o.frequency.setValueAtTime(freq, when);
    o.frequency.exponentialRampToValueAtTime(freq * 0.98, when + dur);
    g.gain.setValueAtTime(0.0001, when);
    g.gain.exponentialRampToValueAtTime(gain, when + 0.004);
    g.gain.exponentialRampToValueAtTime(0.0001, when + dur);
    o.connect(g); g.connect(master);
    o.start(when); o.stop(when + dur + 0.02);
  }
  const soundL = (when, g) => tone(when, 523.25, 'triangle', g == null ? 0.9 : g, 0.18); // C5, warm
  const soundR = (when, g) => tone(when, 784.99, 'square',   g == null ? 0.55 : g, 0.14); // G5, reedy

  // Metronome click (short filtered noise-ish blip via osc).
  function click(when, accent) {
    const c = audio();
    const o = c.createOscillator();
    const g = c.createGain();
    o.type = 'square';
    o.frequency.value = accent ? 1600 : 1000;
    g.gain.setValueAtTime(0.0001, when);
    g.gain.exponentialRampToValueAtTime(accent ? 0.5 : 0.25, when + 0.002);
    g.gain.exponentialRampToValueAtTime(0.0001, when + 0.05);
    o.connect(g); g.connect(master);
    o.start(when); o.stop(when + 0.06);
  }

  // ---------- Lookahead scheduler for metronome / reference guide ----------
  let schedTimer = null;
  let schedUntil = 0;                     // audio time already scheduled up to
  const AHEAD = 0.13;                     // seconds

  function scheduleTick() {
    if (!S.running || S.mode !== 'fixed') return;
    const c = audio();
    const from = schedUntil;
    const to = c.currentTime + AHEAD;
    const cyc = cycleSec();
    const a = S.ratioL, b = S.ratioR;
    let kStart = Math.floor((from - S.startAudio) / cyc);
    if (kStart < 0) kStart = 0;
    const kEnd = Math.ceil((to - S.startAudio) / cyc) + 1;

    for (let k = kStart; k <= kEnd; k++) {
      const base = S.startAudio + k * cyc;
      // downbeat click
      if (S.metro) fire(base, () => click(base, true), from, to);
      if (S.guide) {
        for (let i = 0; i < a; i++) {
          const t = base + i * cyc / a;
          fire(t, () => soundL(t, 0.35), from, to);
        }
        for (let j = 0; j < b; j++) {
          const t = base + j * cyc / b;
          fire(t, () => soundR(t, 0.22), from, to);
        }
      }
    }
    schedUntil = to;
  }
  function fire(t, fn, from, to) { if (t > from && t <= to) fn(); }

  function startScheduler() {
    schedUntil = audio().currentTime;
    scheduleTick();
    schedTimer = setInterval(scheduleTick, 25);
  }
  function stopScheduler() { clearInterval(schedTimer); schedTimer = null; }

  // =========================================================================
  //  Tap handling
  // =========================================================================
  function registerTap(hand) {
    const now = performance.now();
    // immediate audible feedback — play right now on the audio clock
    const c = audio();
    if (c.state === 'suspended') c.resume();
    if (hand === 'L') soundL(c.currentTime); else soundR(c.currentTime);

    if (!S.running) return;               // only record while running
    const e = now - S.startPerf;
    const t = { hand, e };
    if (S.mode === 'fixed') {
      const ev = evaluateTap(hand, e);
      t.off = ev.off; t.abs = ev.abs;
    } else {
      t.off = null; t.abs = null;
    }
    S.taps.push(t);
    updateStats();
  }

  // =========================================================================
  //  Stats + phase scatter
  // =========================================================================
  function updateStats() {
    const scored = S.taps.filter(t => t.abs != null);
    el.stTaps.textContent = S.taps.length;
    if (S.mode === 'fixed' && scored.length) {
      const avg = scored.reduce((s, t) => s + t.abs, 0) / scored.length;
      const inTime = scored.filter(t => t.abs <= TOL_OK).length;
      el.stAvg.textContent = Math.round(avg) + 'ms';
      el.stIn.textContent = Math.round(100 * inTime / scored.length) + '%';
      // best streak of "in time" taps
      let best = 0, cur = 0;
      for (const t of scored) { if (t.abs <= TOL_OK) { cur++; best = Math.max(best, cur); } else cur = 0; }
      el.stStreak.textContent = best;
    } else {
      el.stAvg.textContent = '–'; el.stIn.textContent = '–'; el.stStreak.textContent = '0';
    }
    drawPhase();
  }

  function colorFor(abs) {
    if (abs <= TOL_GOOD) return getVar('--good');
    if (abs <= TOL_OK) return getVar('--ok');
    return getVar('--bad');
  }
  const getVar = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();

  // =========================================================================
  //  Canvas: scrolling timeline
  // =========================================================================
  const tl = el.timeline, tctx = tl.getContext('2d');
  const ph = el.phase, pctx = ph.getContext('2d');
  const PX_PER_SEC = 150;
  const NOW_FRAC = 0.34;      // now-line position from the left

  function fitCanvas(canvas, fallbackH) {
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth || canvas.parentElement.clientWidth;
    const h = canvas.clientHeight || fallbackH;   // CSS-driven → responsive height
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    canvas.getContext('2d').setTransform(dpr, 0, 0, dpr, 0, 0);
    return { w, h };
  }
  let tlSize = { w: 600, h: 210 }, phSize = { w: 600, h: 120 };
  function resize() {
    tlSize = fitCanvas(tl, 210);
    phSize = fitCanvas(ph, 120);
    drawPhase();
    if (!S.running) drawTimeline(true);
  }
  window.addEventListener('resize', resize);
  window.addEventListener('orientationchange', () => setTimeout(resize, 150));

  function laneY(hand) {
    // Left lane upper third, Right lane lower third.
    return hand === 'L' ? tlSize.h * 0.33 : tlSize.h * 0.67;
  }

  function drawTimeline(frozen) {
    const w = tlSize.w, h = tlSize.h;
    tctx.clearRect(0, 0, w, h);

    // background lanes
    tctx.fillStyle = 'rgba(255,255,255,.02)';
    tctx.fillRect(0, laneY('L') - 34, w, 68);
    tctx.fillRect(0, laneY('R') - 34, w, 68);

    // lane labels
    tctx.font = '600 12px sans-serif';
    tctx.textBaseline = 'middle';
    tctx.fillStyle = getVar('--l');
    tctx.fillText('LEFT  [' + S.keyL.toUpperCase() + ']', 10, laneY('L') - 44);
    tctx.fillStyle = getVar('--r');
    tctx.fillText('RIGHT [' + S.keyR.toUpperCase() + ']', 10, laneY('R') + 46);

    const nowX = w * NOW_FRAC;
    const now = frozen ? (S.stopPerf - S.startPerf) : (performance.now() - S.startPerf); // ms
    const pxPerMs = PX_PER_SEC / 1000;
    const leftMs = now - nowX / pxPerMs;
    const rightMs = now + (w - nowX) / pxPerMs;
    const xOf = (e) => nowX + (e - now) * pxPerMs;

    // reference marks + cycle grid (fixed mode)
    if (S.mode === 'fixed') {
      const cyc = cycleMs();
      // cycle boundaries
      let k0 = Math.floor(leftMs / cyc);
      if (k0 < 0) k0 = 0;
      const k1 = Math.ceil(rightMs / cyc);
      tctx.strokeStyle = 'rgba(255,255,255,.06)';
      tctx.lineWidth = 1;
      for (let k = k0; k <= k1; k++) {
        const x = xOf(k * cyc);
        tctx.beginPath(); tctx.moveTo(x, 12); tctx.lineTo(x, h - 12); tctx.stroke();
      }
      // reference ticks per hand
      drawRefs('L', getVar('--l'), leftMs, rightMs, xOf, now);
      drawRefs('R', getVar('--r'), leftMs, rightMs, xOf, now);
    }

    // taps
    for (const t of S.taps) {
      if (t.e < leftMs - 40 || t.e > rightMs + 40) continue;
      const x = xOf(t.e), y = laneY(t.hand);
      const col = t.abs == null ? (t.hand === 'L' ? getVar('--l') : getVar('--r')) : colorFor(t.abs);
      // connector to its reference (fixed mode)
      if (t.off != null) {
        const refX = xOf(t.e - t.off);
        tctx.strokeStyle = col; tctx.globalAlpha = .5; tctx.lineWidth = 2;
        tctx.beginPath(); tctx.moveTo(refX, y); tctx.lineTo(x, y); tctx.stroke();
        tctx.globalAlpha = 1;
      }
      tctx.fillStyle = col;
      tctx.beginPath(); tctx.arc(x, y, 6, 0, 7); tctx.fill();
      tctx.strokeStyle = 'rgba(0,0,0,.4)'; tctx.lineWidth = 1; tctx.stroke();
    }

    // NOW line
    tctx.strokeStyle = getVar('--accent');
    tctx.lineWidth = 2;
    tctx.beginPath(); tctx.moveTo(nowX, 6); tctx.lineTo(nowX, h - 6); tctx.stroke();
    tctx.fillStyle = getVar('--accent');
    tctx.font = '700 11px sans-serif';
    tctx.textBaseline = 'top';
    tctx.fillText('NOW', nowX + 5, 8);
  }

  function drawRefs(hand, color, leftMs, rightMs, xOf, now) {
    const iv = intervalMs(hand);
    let i0 = Math.floor(leftMs / iv);
    if (i0 < 0) i0 = 0;
    const i1 = Math.ceil(rightMs / iv);
    const y = laneY(hand);
    for (let i = i0; i <= i1; i++) {
      const e = i * iv;
      const x = xOf(e);
      const near = Math.abs(e - now) < 60;   // highlight the imminent one
      tctx.strokeStyle = color;
      tctx.globalAlpha = near ? 1 : 0.5;
      tctx.lineWidth = near ? 3 : 2;
      tctx.beginPath(); tctx.moveTo(x, y - 22); tctx.lineTo(x, y + 22); tctx.stroke();
      tctx.globalAlpha = 1;
    }
  }

  // phase scatter — every tap folded into one cycle, both hands
  function drawPhase() {
    const w = phSize.w, h = phSize.h;
    pctx.clearRect(0, 0, w, h);
    if (S.mode !== 'fixed') return;
    const midL = h * 0.32, midR = h * 0.72;
    const pad = 34, span = w - pad * 2;

    // guide rails
    for (const [y, hand, col] of [[midL, 'L', getVar('--l')], [midR, 'R', getVar('--r')]]) {
      pctx.strokeStyle = 'rgba(255,255,255,.10)';
      pctx.lineWidth = 1;
      pctx.beginPath(); pctx.moveTo(pad, y); pctx.lineTo(w - pad, y); pctx.stroke();
      // tolerance band around center
      const iv = intervalMs(hand);
      const okPx = (TOL_OK / iv) * span;     // fraction of interval
      pctx.fillStyle = 'rgba(52,211,153,.10)';
      pctx.fillRect(w / 2 - okPx, y - 12, okPx * 2, 24);
      // perfect center line
      pctx.strokeStyle = col; pctx.globalAlpha = .7;
      pctx.beginPath(); pctx.moveTo(w / 2, y - 16); pctx.lineTo(w / 2, y + 16); pctx.stroke();
      pctx.globalAlpha = 1;
      pctx.fillStyle = getVar('--muted'); pctx.font = '10px sans-serif'; pctx.textBaseline = 'middle';
      pctx.fillText(hand === 'L' ? 'L' : 'R', 12, y);
      pctx.fillText('early', w / 2 - okPx - 30, y - 20 < 8 ? 8 : y - 20);
    }
    // plot: x = center + (off / (interval/2)) * (span/2), clamp
    for (const t of S.taps) {
      if (t.off == null) continue;
      const iv = intervalMs(t.hand);
      let frac = t.off / (iv / 2);          // -1..+1 across half interval
      frac = Math.max(-1.15, Math.min(1.15, frac));
      const x = w / 2 + frac * (span / 2);
      const y = t.hand === 'L' ? midL : midR;
      pctx.fillStyle = colorFor(t.abs);
      pctx.globalAlpha = .85;
      pctx.beginPath(); pctx.arc(x, y, 5, 0, 7); pctx.fill();
      pctx.globalAlpha = 1;
    }
  }

  // ---------- animation loop ----------
  function loop() {
    if (S.running) drawTimeline(false);
    requestAnimationFrame(loop);
  }

  // =========================================================================
  //  Start / stop
  // =========================================================================
  // keep both Start buttons (controls + mobile tapbar) in sync
  function setRunLabel() {
    const r = S.running;
    if (el.startBtn) { el.startBtn.textContent = r ? '■ Stop' : '▶ Start'; el.startBtn.classList.toggle('running', r); }
    if (el.startBtn2) { el.startBtn2.textContent = r ? '■' : '▶'; el.startBtn2.classList.toggle('running', r); }
    document.body.classList.toggle('running', r);
  }
  function syncPadKeys() {
    if (el.padKeyL) el.padKeyL.textContent = label(S.keyL);
    if (el.padKeyR) el.padKeyR.textContent = label(S.keyR);
  }

  function start() {
    audio();
    if (ctx.state === 'suspended') ctx.resume();
    S.taps = [];
    S.running = true;
    S.startPerf = performance.now();
    S.startAudio = ctx.currentTime + 0.06;   // small offset so first downbeat isn't clipped
    setRunLabel();
    el.pbMsg.textContent = '';
    updateStats();
    if (S.mode === 'fixed') startScheduler();
    else stopScheduler();
  }

  function stop() {
    S.running = false;
    S.stopPerf = performance.now();
    stopScheduler();
    setRunLabel();
    drawTimeline(true);
    if (S.mode === 'freestyle') analyzeFreestyle();
  }

  function toggleRun() { S.running ? stop() : start(); }

  // =========================================================================
  //  Freestyle analysis — infer tempo & ratio from the taps
  // =========================================================================
  function median(arr) {
    if (!arr.length) return null;
    const s = [...arr].sort((a, b) => a - b);
    const m = Math.floor(s.length / 2);
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  }
  // robust period: median of inter-onset intervals, refined by folding
  function estPeriod(times) {
    if (times.length < 2) return null;
    const iois = [];
    for (let i = 1; i < times.length; i++) iois.push(times[i] - times[i - 1]);
    return median(iois);
  }

  // Approximate x by a fraction p/q (p,q <= maxD). Humans tapping freestyle mean
  // *simple* ratios, so return the SIMPLEST fraction within `tol` relative error
  // (denominators scanned ascending). Only if nothing fits do we take the closest.
  // This keeps a jittery 0.735 reading as 3:4 instead of the "closer" but absurd 8:11.
  function rationalize(x, maxD, tol) {
    let best = { p: 1, q: 1, err: Infinity };
    for (let q = 1; q <= maxD; q++) {
      const p = Math.round(x * q);
      if (p < 1 || p > maxD) continue;
      const err = Math.abs(x - p / q);
      if (err < best.err - 1e-9) best = { p, q, err };
      if (tol && x > 0 && err / x <= tol) return { p, q, err };  // simplest within tolerance
    }
    return best;
  }
  function gcd(a, b) { return b ? gcd(b, a % b) : a; }

  function analyzeFreestyle() {
    const L = S.taps.filter(t => t.hand === 'L').map(t => t.e);
    const R = S.taps.filter(t => t.hand === 'R').map(t => t.e);
    const pL = estPeriod(L), pR = estPeriod(R);

    if (!pL && !pR) {
      el.anBody.innerHTML = 'Not enough taps yet — tap each hand a few times, then Stop.';
      return;
    }
    const rows = [];
    const bpmOf = (p) => p ? Math.round(60000 / p) : null;
    if (pL) rows.push(`<span class="k">Left:</span> ~<b class="big" style="color:var(--l)">${bpmOf(pL)}</b> bpm <span class="k">(${Math.round(pL)}ms apart, ${L.length} taps)</span>`);
    if (pR) rows.push(`<span class="k">Right:</span> ~<b class="big" style="color:var(--r)">${bpmOf(pR)}</b> bpm <span class="k">(${Math.round(pR)}ms apart, ${R.length} taps)</span>`);

    let ratioTxt = '';
    if (pL && pR) {
      // beats-per-time ratio L:R = (1/pL):(1/pR) = pR:pL
      const x = pR / pL;                 // = countL / countR
      const frac = rationalize(x, 16, 0.03);   // prefer the simplest ratio within 3%
      const g = gcd(frac.p, frac.q) || 1;
      const p = frac.p / g, q = frac.q / g;
      const conf = frac.err / x;         // relative error
      const quality = conf < 0.04 ? 'clean' : conf < 0.09 ? 'roughly' : 'loosely';
      ratioTxt = `<div style="margin-top:10px"><span class="k">Detected ratio (L:R):</span>
        <b class="big">${p} : ${q}</b> <span class="k">— ${quality} matched</span></div>`;
      // suggest loading it into fixed mode
      ratioTxt += `<button id="useRatio" class="ghost" style="margin-top:10px">Use ${p}:${q} in Fixed mode →</button>`;
    }

    el.anBody.innerHTML = rows.join('<br>') + ratioTxt;
    const use = $('useRatio');
    if (use) use.addEventListener('click', () => {
      const m = use.textContent.match(/(\d+):(\d+)/);
      if (m) { S.ratioL = +m[1]; S.ratioR = +m[2]; el.ratioL.value = m[1]; el.ratioR.value = m[2]; syncPresets(); updateDerived(); setMode('fixed'); }
    });
  }

  // =========================================================================
  //  Playback
  // =========================================================================
  function playTaps() {
    if (!S.taps.length) { el.pbMsg.textContent = 'No taps recorded yet.'; return; }
    const c = audio();
    if (c.state === 'suspended') c.resume();
    const t0 = Math.min(...S.taps.map(t => t.e));
    const base = c.currentTime + 0.25;
    for (const t of S.taps) {
      const when = base + (t.e - t0) / 1000;
      if (t.hand === 'L') soundL(when); else soundR(when);
    }
    const dur = (Math.max(...S.taps.map(t => t.e)) - t0) / 1000;
    el.pbMsg.textContent = `Playing ${S.taps.length} taps (${dur.toFixed(1)}s)…`;
    setTimeout(() => { el.pbMsg.textContent = ''; }, (dur + 0.5) * 1000);
  }

  function playReference() {
    const c = audio();
    if (c.state === 'suspended') c.resume();
    const cyc = cycleSec();
    const cycles = 4;
    const base = c.currentTime + 0.2;
    for (let k = 0; k < cycles; k++) {
      const b = base + k * cyc;
      if (S.metro) click(b, true);
      for (let i = 0; i < S.ratioL; i++) soundL(b + i * cyc / S.ratioL, 0.7);
      for (let j = 0; j < S.ratioR; j++) soundR(b + j * cyc / S.ratioR, 0.45);
    }
    el.pbMsg.textContent = `Playing ${S.ratioL}:${S.ratioR} reference × ${cycles}…`;
    setTimeout(() => { el.pbMsg.textContent = ''; }, (cycles * cyc + 0.5) * 1000);
  }

  // =========================================================================
  //  UI wiring
  // =========================================================================
  const PRESETS = ['2:3', '3:4', '4:3', '3:2', '4:5', '5:4', '3:7', '5:7', '4:7', '7:11', '9:11'];
  function buildPresets() {
    el.presets.innerHTML = '';
    PRESETS.forEach(p => {
      const [a, b] = p.split(':');
      const btn = document.createElement('button');
      btn.className = 'preset';
      btn.textContent = p;
      btn.dataset.a = a; btn.dataset.b = b;
      btn.addEventListener('click', () => {
        S.ratioL = +a; S.ratioR = +b;
        el.ratioL.value = a; el.ratioR.value = b;
        syncPresets(); updateDerived();
      });
      el.presets.appendChild(btn);
    });
    syncPresets();
  }
  function syncPresets() {
    [...el.presets.children].forEach(btn => {
      btn.classList.toggle('active', +btn.dataset.a === S.ratioL && +btn.dataset.b === S.ratioR);
    });
  }

  function updateDerived() {
    el.tempoHint.textContent = S.tempoRef === 'cycle'
      ? '(one full cycle per beat)'
      : `(counts the ${S.tempoRef} hand)`;
    const li = intervalMs('L'), ri = intervalMs('R');
    el.derived.innerHTML =
      `Cycle = <b>${cycleMs().toFixed(0)}ms</b> · ` +
      `<b class="l">L</b> every ${li.toFixed(0)}ms · ` +
      `<b class="r">R</b> every ${ri.toFixed(0)}ms`;
  }

  function setMode(mode) {
    S.mode = mode;
    document.body.classList.toggle('fixed', mode === 'fixed');
    document.body.classList.toggle('free', mode === 'freestyle');
    el.modeFixed.classList.toggle('active', mode === 'fixed');
    el.modeFree.classList.toggle('active', mode === 'freestyle');
    el.stageTitle.textContent = mode === 'fixed' ? 'Practice timeline' : 'Freestyle capture';
    el.tapHint.innerHTML = mode === 'fixed'
      ? 'Land each tap on its <b>reference tick</b> as it crosses the <b>Now</b> line. Green = tight, red = off.'
      : 'Just tap your rhythm. Press <b>Stop</b> and I\'ll estimate your tempo &amp; ratio.';
    if (S.running) stop();
    S.taps = [];
    updateStats();
    resize();   // refit canvases (phase scatter toggles visibility between modes)
  }

  // key binding
  function beginBind(hand) {
    S.binding = hand;
    el.bindL.classList.toggle('binding', hand === 'L');
    el.bindR.classList.toggle('binding', hand === 'R');
    el.bindMsg.textContent = `Press any key to set the ${hand === 'L' ? 'LEFT' : 'RIGHT'} hand…`;
  }
  function endBind() {
    S.binding = null;
    el.bindL.classList.remove('binding');
    el.bindR.classList.remove('binding');
    el.bindMsg.textContent = 'Click a hand, then press any key to bind it.';
  }

  // =========================================================================
  //  Events
  // =========================================================================
  el.modeFixed.addEventListener('click', () => setMode('fixed'));
  el.modeFree.addEventListener('click', () => setMode('freestyle'));

  el.ratioL.addEventListener('input', () => { S.ratioL = clampInt(el.ratioL, 1, 16); syncPresets(); updateDerived(); });
  el.ratioR.addEventListener('input', () => { S.ratioR = clampInt(el.ratioR, 1, 16); syncPresets(); updateDerived(); });
  function clampInt(input, lo, hi) {
    let v = parseInt(input.value, 10); if (isNaN(v)) v = lo;
    v = Math.max(lo, Math.min(hi, v)); return v;
  }

  el.bpm.addEventListener('input', () => { S.bpm = +el.bpm.value; el.bpmVal.textContent = S.bpm; updateDerived(); });
  el.tempoRef.addEventListener('change', () => { S.tempoRef = el.tempoRef.value; updateDerived(); });
  el.metro.addEventListener('change', () => { S.metro = el.metro.checked; });
  el.guide.addEventListener('change', () => { S.guide = el.guide.checked; });
  el.volume.addEventListener('input', () => { S.volume = +el.volume.value / 100; if (master) master.gain.value = S.volume; });

  el.bindL.addEventListener('click', () => beginBind('L'));
  el.bindR.addEventListener('click', () => beginBind('R'));

  el.startBtn.addEventListener('click', toggleRun);
  el.clearBtn.addEventListener('click', () => { S.taps = []; updateStats(); drawTimeline(true); el.pbMsg.textContent = ''; });
  el.playTaps.addEventListener('click', playTaps);
  el.playRef.addEventListener('click', playReference);

  window.addEventListener('keydown', (e) => {
    // binding capture
    if (S.binding) {
      e.preventDefault();
      const key = normalizeKey(e);
      if (!key) return;
      const other = S.binding === 'L' ? S.keyR : S.keyL;
      if (key === other) { el.bindMsg.textContent = 'That key is already used by the other hand.'; return; }
      if (S.binding === 'L') { S.keyL = key; el.keyL.textContent = label(key); }
      else { S.keyR = key; el.keyR.textContent = label(key); }
      syncPadKeys();
      endBind();
      drawTimeline(!S.running);
      return;
    }
    if (e.repeat) return;                 // ignore auto-repeat
    const key = normalizeKey(e);
    if (key === S.keyL) { e.preventDefault(); registerTap('L'); }
    else if (key === S.keyR) { e.preventDefault(); registerTap('R'); }
    else if (e.code === 'Space') { e.preventDefault(); toggleRun(); }  // Space = start/stop
  });

  // key names: single chars lowercased; special codes kept
  function normalizeKey(e) {
    if (e.key === ' ' || e.code === 'Space') return ' ';
    if (e.key.length === 1) return e.key.toLowerCase();
    return e.key;                          // e.g. 'ArrowLeft', 'Enter', 'Shift'
  }
  function label(k) {
    if (k === ' ') return 'Space';
    if (k.startsWith('Arrow')) return { ArrowLeft: '←', ArrowRight: '→', ArrowUp: '↑', ArrowDown: '↓' }[k];
    return k.length === 1 ? k.toUpperCase() : k;
  }

  // =========================================================================
  //  Touch pads (mobile) — Pointer Events for multi-touch + low latency
  // =========================================================================
  function bindPad(pad, hand) {
    if (!pad) return;
    const down = (ev) => {
      ev.preventDefault();                 // suppress zoom / scroll / text-select
      pad.classList.add('active');
      registerTap(hand);
      if (navigator.vibrate) { try { navigator.vibrate(8); } catch (e) {} }
    };
    const up = () => pad.classList.remove('active');
    pad.addEventListener('pointerdown', down);
    pad.addEventListener('pointerup', up);
    pad.addEventListener('pointercancel', up);
    pad.addEventListener('pointerleave', up);
    pad.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  // =========================================================================
  //  PWA install ("Add to Home Screen") + service worker
  // =========================================================================
  let deferredPrompt = null;
  const isStandalone = () =>
    window.matchMedia('(display-mode: standalone)').matches ||
    window.matchMedia('(display-mode: fullscreen)').matches ||
    window.navigator.standalone === true;
  const isiOS = () =>
    /iphone|ipad|ipod/i.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

  const showInstallChip = () => { if (el.installBtn && !isStandalone()) el.installBtn.hidden = false; };
  const hideInstallChip = () => { if (el.installBtn) el.installBtn.hidden = true; };

  window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); deferredPrompt = e; showInstallChip(); });
  window.addEventListener('appinstalled', () => { deferredPrompt = null; hideInstallChip(); });

  function setupInstall() {
    if (isStandalone()) { hideInstallChip(); return; }
    if (isiOS()) showInstallChip();        // iOS lacks beforeinstallprompt → show manual guide
    if (el.installBtn) el.installBtn.addEventListener('click', async () => {
      if (deferredPrompt) {
        deferredPrompt.prompt();
        try { await deferredPrompt.userChoice; } catch (e) {}
        deferredPrompt = null;
        hideInstallChip();
      } else if (el.iosHelp) {
        el.iosHelp.hidden = false;
      }
    });
    if (el.iosClose) el.iosClose.addEventListener('click', () => { el.iosHelp.hidden = true; });
    if (el.iosHelp) el.iosHelp.addEventListener('click', (e) => { if (e.target === el.iosHelp) el.iosHelp.hidden = true; });
  }

  function registerSW() {
    if (!('serviceWorker' in navigator) || location.protocol.indexOf('http') !== 0) return;
    // Self-heal: when a NEW worker takes control of an already-controlled page
    // (e.g. an old buggy SW being replaced), reload once so the fresh assets win.
    const hadController = navigator.serviceWorker.controller != null;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (!hadController || window.__swReloaded) return;   // skip on first-ever install
      window.__swReloaded = true;
      location.reload();
    });
    window.addEventListener('load', () => { navigator.serviceWorker.register('sw.js').catch(() => {}); });
  }

  // =========================================================================
  //  Init
  // =========================================================================
  function init() {
    buildPresets();
    updateDerived();
    setMode('fixed');
    el.keyL.textContent = label(S.keyL);
    el.keyR.textContent = label(S.keyR);
    syncPadKeys();
    bindPad(el.padL, 'L');
    bindPad(el.padR, 'R');
    if (el.startBtn2) el.startBtn2.addEventListener('click', toggleRun);
    setRunLabel();
    setupInstall();
    registerSW();
    // canvases need layout first
    requestAnimationFrame(() => { resize(); loop(); });
  }
  init();
})();
