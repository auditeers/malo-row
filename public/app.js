// --- Rowing pacer engine -------------------------------------------------
// Workout JSON shape:
// {
//   "name": "string",
//   "stages": [
//     { "name": "string", "type": "warmup|row|rest|cooldown", "duration": seconds, "spm": number, "driveRatio": 0..1 (optional - overrides the automatic drive:recovery split for that stage) }
//   ]
// }
//
// Timing model: elapsed time is always derived from an absolute wall-clock
// reference point (performance.now()), never accumulated frame-by-frame.
// That means if the browser throttles rAF (backgrounded tab, locked screen -
// both common mid-workout), the displayed time and stroke cadence snap back
// to the correct value the instant rendering resumes, instead of drifting or
// stalling. Nothing about the cadence depends on frame rate.

// On an erg, the drive is the fast/powerful part of the stroke and the
// recovery is the slower, controlled return - at low rates recovery takes
// roughly twice as long as the drive (~1:2), but rate increases are achieved
// mostly by shortening the recovery rather than the drive, so the two
// converge toward roughly even (~1:1) at sprint rates. Anchored to typical
// reference timings: ~20 spm -> 1.0s drive / 2.0s recovery, ~40 spm -> 0.7s
// drive / 0.8s recovery. Clamped so drive never becomes the longer phase.
function driveFractionForSpm(spm) {
  const raw = 0.333 + (spm - 20) * 0.0067;
  return Math.max(0.25, Math.min(0.5, raw));
}

const DEFAULT_WORKOUT = {
  name: '20 minuten intervalmix',
  stages: [
    { name: 'Warming up', type: 'warmup', duration: 300, spm: 18 },
    { name: 'Interval 1', type: 'row', duration: 120, spm: 24 },
    { name: 'Rust', type: 'rest', duration: 60, spm: 0 },
    { name: 'Interval 2', type: 'row', duration: 120, spm: 26 },
    { name: 'Rust', type: 'rest', duration: 60, spm: 0 },
    { name: 'Interval 3', type: 'row', duration: 120, spm: 28 },
    { name: 'Rust', type: 'rest', duration: 60, spm: 0 },
    { name: 'Afkoelen', type: 'cooldown', duration: 300, spm: 16 },
  ],
};

const CX = 200, CY = 205, R = 155;

const els = {
  statTotal: document.getElementById('stat-total'),
  statElapsed: document.getElementById('stat-elapsed'),
  statRemaining: document.getElementById('stat-remaining'),
  statStrokes: document.getElementById('stat-strokes'),
  upcomingTitle: document.getElementById('upcoming-title'),
  phaseLabel: document.getElementById('phase-label'),
  stageCount: document.getElementById('stage-count'),
  actionLabel: document.getElementById('action-label'),
  stageTimer: document.getElementById('stage-timer'),
  stageName: document.getElementById('stage-name'),
  spmValue: document.getElementById('spm-value'),
  arcBg: document.getElementById('arc-bg'),
  arcProgress: document.getElementById('arc-progress'),
  strokeBarFill: document.getElementById('stroke-bar-fill'),
  strokeBarThumb: document.getElementById('stroke-bar-thumb'),
  cadencePanel: document.getElementById('cadence-panel'),
  countdownOverlay: document.getElementById('countdown-overlay'),
  countdownNumber: document.getElementById('countdown-number'),
  iconPlay: document.getElementById('icon-play'),
  iconPause: document.getElementById('icon-pause'),
  settingsBtn: document.getElementById('settings-btn'),
  rotateBanner: document.getElementById('rotate-banner'),
  rotateBannerClose: document.getElementById('rotate-banner-close'),
  settingsPanel: document.getElementById('settings-panel'),
  settingsClose: document.getElementById('settings-close'),
  workoutName: document.getElementById('workout-name'),
  workoutTitle: document.getElementById('workout-title'),
  workoutSelect: document.getElementById('workout-select'),
  fileInput: document.getElementById('file-input'),
  btnLoadExample: document.getElementById('btn-load-example'),
  btnPrev: document.getElementById('btn-prev'),
  btnNext: document.getElementById('btn-next'),
  btnStop: document.getElementById('btn-stop'),
  btnPlayPause: document.getElementById('btn-playpause'),
};

let workout = null;
let cumulative = [];
let totalDuration = 0;

// Wall-clock timing state: at any moment, elapsed = runOffset, plus
// (performance.now() - runStartPerf)/1000 while running.
let runOffset = 0;
let runStartPerf = null;
let running = false;
let wakeLock = null;
let hasStarted = false; // true once the workout has been played at least once

// A "5, 4, 3, 2, 1" get-ready countdown runs before every start (initial or
// after a pause) - the workout clock and stroke beeps don't begin until it
// reaches zero.
const COUNTDOWN_SECONDS = 5;
let countdownActive = false;
let countdownStartPerf = null;

// In the last few seconds of any stage, the countdown color changes and
// ticks once per second as a heads-up that the next stage is about to start.
const STAGE_ENDING_WARNING_SECONDS = 5;

// The elapsed-time point the stroke cycle counts from - reset to the current
// position every time a run begins (initial start or resume from pause), so
// you always meet the catch/Drive first rather than resuming mid-Recovery.
// A stage boundary reached while continuously running still resets the cycle
// naturally too, since the cycle position is clamped to the later of this
// anchor or the current stage's own start.
let cadenceAnchorElapsed = 0;
function cadenceCycleStart(stageStartElapsed) {
  return Math.max(stageStartElapsed, cadenceAnchorElapsed);
}

// Cache of last-rendered text, so we only touch the DOM when a value
// actually changes (keeps the per-frame cost to the arc paths only).
const last = {};
function setText(el, key, value) {
  if (last[key] !== value) {
    last[key] = value;
    el.textContent = value;
  }
}

function getElapsed(nowPerf) {
  if (running && runStartPerf != null) {
    return Math.min(totalDuration, runOffset + (nowPerf - runStartPerf) / 1000);
  }
  return runOffset;
}

function setElapsed(value, nowPerf) {
  value = Math.max(0, Math.min(totalDuration, value));
  if (running) {
    runOffset = value;
    runStartPerf = nowPerf != null ? nowPerf : performance.now();
  } else {
    runOffset = value;
  }
}

function polarToCartesian(cx, cy, r, angleDeg) {
  const rad = (angleDeg * Math.PI) / 180;
  return { x: cx + r * Math.cos(rad), y: cy - r * Math.sin(rad) };
}

function angleForFraction(f) {
  return 180 - f * 180;
}

function describeArc(radius, f1, f2) {
  f1 = Math.max(0, Math.min(1, f1));
  f2 = Math.max(0, Math.min(1, f2));
  if (f2 <= f1) return '';
  const startAngle = angleForFraction(f1);
  const endAngle = angleForFraction(f2);
  const start = polarToCartesian(CX, CY, radius, startAngle);
  const end = polarToCartesian(CX, CY, radius, endAngle);
  const largeArcFlag = startAngle - endAngle <= 180 ? 0 : 1;
  return `M ${start.x} ${start.y} A ${radius} ${radius} 0 ${largeArcFlag} 1 ${end.x} ${end.y}`;
}

function formatTime(seconds) {
  seconds = Math.max(0, Math.round(seconds));
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function loadWorkout(data) {
  if (!data || !Array.isArray(data.stages) || data.stages.length === 0) {
    alert('Ongeldig workout JSON-bestand: verwacht een "stages" array.');
    return;
  }
  workout = data;
  cumulative = [];
  let acc = 0;
  for (const stage of workout.stages) {
    cumulative.push(acc);
    acc += stage.duration;
  }
  totalDuration = acc;
  running = false;
  hasStarted = false;
  countdownActive = false;
  countdownStartPerf = null;
  els.countdownOverlay.hidden = true;
  runStartPerf = null;
  runOffset = 0;
  stopAudioScheduler();
  cancelPendingCadenceBeeps();
  releaseWakeLock();
  els.workoutName.textContent = workout.name || 'Workout geladen';
  els.workoutTitle.textContent = workout.name || '';
  render(performance.now());
}

function getCurrentStageIndex(elapsed) {
  if (elapsed >= totalDuration) return workout.stages.length - 1;
  for (let i = workout.stages.length - 1; i >= 0; i--) {
    if (elapsed >= cumulative[i]) return i;
  }
  return 0;
}

// Target stroke count: how many strokes you should have completed by now at
// each stage's target SPM, summed across every stage reached so far. This is
// independent of the cadence-anchor reset used for the live Drive/Recover
// indicator - it's a straightforward pace target, so pausing/resuming never
// loses or duplicates counted strokes.
function computeStrokeCount(elapsed) {
  let strokes = 0;
  for (let i = 0; i < workout.stages.length && cumulative[i] < elapsed; i++) {
    const stage = workout.stages[i];
    if (stage.spm <= 0) continue;
    const stageElapsed = Math.min(elapsed, cumulative[i] + stage.duration) - cumulative[i];
    strokes += Math.floor(stageElapsed / (60 / stage.spm));
  }
  return strokes;
}

// Fixed 200x200 SVG background arc path, computed once (never changes).
els.arcBg.setAttribute('d', describeArc(R, 0, 1));

function updatePlayPauseIcon(playing) {
  if (last.playing !== playing) {
    last.playing = playing;
    els.iconPlay.style.display = playing ? 'none' : 'block';
    els.iconPause.style.display = playing ? 'block' : 'none';
  }
}

function render(nowPerf) {
  if (!workout) return;

  if (countdownActive) {
    const remaining = COUNTDOWN_SECONDS - (nowPerf - countdownStartPerf) / 1000;
    if (remaining <= 0) {
      countdownActive = false;
      countdownStartPerf = null;
      els.countdownOverlay.hidden = true;
      running = true;
      hasStarted = true;
      runStartPerf = nowPerf;
      cadenceAnchorElapsed = runOffset; // every start/resume begins fresh at the Drive catch, not mid-cycle
      requestWakeLock();
      startAudioScheduler();
      beep(1000, 0.15); // "go"
      vibrate([60, 40, 60]); // double buzz - distinct from the plain ticks
    } else {
      // Clamp: a rAF timestamp can land a hair before the click handler's own
      // performance.now(), making `remaining` compute just over 5s on the
      // very first frame - Math.ceil would then briefly read 6 (invalid,
      // the countdown only ever runs 5..1) and fire a spurious extra tick.
      const shown = Math.min(COUNTDOWN_SECONDS, Math.ceil(remaining));
      if (last.countdownShown !== shown) {
        last.countdownShown = shown;
        els.countdownNumber.textContent = String(shown);
        beep(600, 0.08); // tick
        vibrate(40);
        els.strokeBarFill.style.width = '0%';
        els.strokeBarThumb.style.left = '0%';
        els.cadencePanel.style.boxShadow = '';
        setText(els.phaseLabel, 'phaseText', ' ');
        if (last.phaseClass !== 'none') {
          last.phaseClass = 'none';
          els.phaseLabel.className = 'phase-label';
        }
        last.phaseColor = null;
      }
      updatePlayPauseIcon(true);
      return;
    }
  }

  const elapsed = getElapsed(nowPerf);
  const idx = getCurrentStageIndex(elapsed);
  const stage = workout.stages[idx];
  const stageStart = cumulative[idx];
  const stageElapsed = Math.max(0, elapsed - stageStart);
  const stageRemaining = stage.duration - stageElapsed;
  const finished = elapsed >= totalDuration;

  setText(els.statTotal, 'total', formatTime(totalDuration));
  setText(els.statElapsed, 'elapsed', formatTime(elapsed));
  setText(els.statRemaining, 'remaining', formatTime(totalDuration - elapsed));
  setText(els.statStrokes, 'strokes', String(computeStrokeCount(elapsed)));

  setText(els.stageCount, 'stageCount', `${idx + 1}/${workout.stages.length}`);
  setText(els.stageTimer, 'stageTimer', formatTime(finished ? 0 : stageRemaining));
  setText(els.stageName, 'stageName', finished ? 'klaar' : stage.name);
  setText(els.spmValue, 'spm', String(stage.spm));

  // Heads-up for the next stage: color the countdown for the last few
  // seconds and tick once per second, same cue language as the get-ready
  // countdown at the start.
  const stageEnding = !finished && stageRemaining > 0 && stageRemaining <= STAGE_ENDING_WARNING_SECONDS;
  if (last.stageEnding !== stageEnding) {
    last.stageEnding = stageEnding;
    els.stageTimer.className = 'stage-timer' + (stageEnding ? ' ending' : '');
  }
  if (stageEnding) {
    const secondsLeft = Math.ceil(stageRemaining);
    if (last.stageEndingSecond !== secondsLeft) {
      last.stageEndingSecond = secondsLeft;
      if (running) {
        beep(700, 0.07);
        vibrate(40);
      }
    }
  } else {
    last.stageEndingSecond = null;
  }

  const paused = !running && !finished && hasStarted;
  setText(els.actionLabel, 'action', paused ? 'PAUZE' : stage.spm > 0 ? 'RIJ' : 'RUST');
  if (last.actionPaused !== paused) {
    last.actionPaused = paused;
    els.actionLabel.className = 'action-label' + (paused ? ' paused' : '');
  }

  const nextIdx = idx + 1;
  let upcoming;
  if (finished) {
    upcoming = 'Klaar!';
  } else if (nextIdx >= workout.stages.length) {
    upcoming = 'Laatste stap';
  } else {
    const next = workout.stages[nextIdx];
    upcoming = `${formatTime(next.duration)} - ${next.spm} SPM`;
  }
  setText(els.upcomingTitle, 'upcoming', upcoming);

  // Stroke-phase (drive/recover) VISUAL cycle - the bar/label only, purely
  // for display. This runs off the rAF render loop, so a few ms of jitter
  // here doesn't matter. The audible beeps are handled entirely separately
  // by the look-ahead audio scheduler below, which is what actually needs
  // to land on the exact stroke boundary.
  let sweep = 0;
  const cadenceVisible = stage.spm > 0 && !finished;
  if (last.cadenceVisible !== cadenceVisible) {
    last.cadenceVisible = cadenceVisible;
    els.cadencePanel.hidden = !cadenceVisible;
  }
  if (cadenceVisible) {
    const period = 60 / stage.spm;
    const driveRatio = stage.driveRatio != null ? stage.driveRatio : driveFractionForSpm(stage.spm);
    const driveDur = period * driveRatio;
    const recoverDur = period - driveDur;
    const cadenceElapsed = Math.max(0, elapsed - cadenceCycleStart(stageStart));
    const cyclePos = cadenceElapsed % period;
    let phase;
    if (cyclePos < driveDur) {
      phase = 'drive';
      sweep = driveDur > 0 ? cyclePos / driveDur : 1;
    } else {
      phase = 'recover';
      const t = recoverDur > 0 ? (cyclePos - driveDur) / recoverDur : 1;
      sweep = 1 - t;
    }

    const phaseText = phase === 'drive' ? 'DRIVE' : 'RECOVER';
    setText(els.phaseLabel, 'phaseText', phaseText);
    if (last.phaseClass !== phase) {
      last.phaseClass = phase;
      els.phaseLabel.className = 'phase-label ' + phase;
    }
    if (last.phaseColor !== phase) {
      last.phaseColor = phase;
      const color = phase === 'drive' ? 'var(--red)' : 'var(--orange)';
      const glow = phase === 'drive' ? 'var(--red-glow)' : 'var(--orange-glow)';
      els.strokeBarFill.style.background = color;
      els.strokeBarThumb.style.borderColor = color;
      els.cadencePanel.style.boxShadow = `0 0 0 1px rgba(0,0,0,0.2), 0 0 26px ${glow}`;
    }
  } else {
    setText(els.phaseLabel, 'phaseText', ' ');
    if (last.phaseClass !== 'none') {
      last.phaseClass = 'none';
      els.phaseLabel.className = 'phase-label';
    }
    if (last.phaseColor !== null) {
      last.phaseColor = null;
      els.cadencePanel.style.boxShadow = '';
    }
  }

  const totalProgress = totalDuration > 0 ? elapsed / totalDuration : 0;

  els.arcProgress.setAttribute('d', describeArc(R, 0, totalProgress));
  els.strokeBarFill.style.width = (sweep * 100).toFixed(1) + '%';
  els.strokeBarThumb.style.left = (sweep * 100).toFixed(1) + '%';

  updatePlayPauseIcon(running && !finished);

  if (finished && running) {
    runOffset = totalDuration; // same ordering hazard as pausing - capture before flipping `running`
    running = false;
    stopAudioScheduler();
    cancelPendingCadenceBeeps();
    releaseWakeLock();
  }
}

function tick(nowPerf) {
  render(nowPerf);
  requestAnimationFrame(tick);
}
requestAnimationFrame(tick);

// Snap immediately to the correct time as soon as the tab/screen comes back,
// instead of waiting for the next natural rAF (which browsers may delay).
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    render(performance.now());
    if (running) requestWakeLock();
    if (audioCtx) ensureAudio();
  }
});

async function requestWakeLock() {
  if (!('wakeLock' in navigator)) return;
  try {
    wakeLock = await navigator.wakeLock.request('screen');
  } catch (e) {
    // Ignore - e.g. not allowed while tab hidden; harmless if it fails.
  }
}
function releaseWakeLock() {
  if (wakeLock) {
    wakeLock.release().catch(() => {});
    wakeLock = null;
  }
}

// --- Cadence sound ----------------------------------------------------------
// Short synthesised tones via Web Audio (no audio file to fetch, no
// playback delay). Two layers:
//
// 1. `beep()` - fires an immediate/one-off tone (countdown ticks, the "go").
//    A few ms of jitter here is imperceptible, so it's simply called from
//    the rAF-driven render loop.
//
// 2. The "cadence scheduler" below - drives the drive/recover stroke beeps.
//    These need to land on the exact stroke boundary or they're useless as
//    a pacing cue, and a beep triggered from inside the rAF render loop can
//    only ever be as precise as the next animation frame (16ms+, worse under
//    any main-thread jank). Instead we run a fast, independent setInterval
//    that looks ~200ms ahead in workout time and hands upcoming stroke
//    events to the Web Audio API's own sample-accurate clock via
//    `osc.start(exactAudioTime)`. The *scheduling* call can be jittery; the
//    actual playback time it hands to the audio thread is not.

let audioCtx = null;
function ensureAudio() {
  if (!audioCtx) {
    const AudioCtor = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtor) return null;
    audioCtx = new AudioCtor();
  }
  if (audioCtx.state === 'suspended') audioCtx.resume();
  return audioCtx;
}

// Converts a performance.now()-domain timestamp to the equivalent point on
// the AudioContext's own clock. Recomputed fresh from simultaneous readings
// of both clocks every time, so there's nothing to keep resynchronised.
function audioTimeFromPerf(perfMs) {
  const nowPerf = performance.now();
  const nowAudio = audioCtx.currentTime;
  return nowAudio + (perfMs - nowPerf) / 1000;
}

// Haptic backup for the discrete cues (countdown ticks, "go", stage-ending
// ticks) - useful over gym music or without headphones in. Deliberately not
// used for the per-stroke cadence beeps: buzzing on every stroke the whole
// workout would be excessive and drain the battery for no real benefit.
// iOS Safari has no Vibration API at all, so this is a no-op there.
function vibrate(pattern) {
  if (navigator.vibrate) {
    try {
      navigator.vibrate(pattern);
    } catch (e) {
      // Ignore - vibration is a nice-to-have, never worth breaking a cue over.
    }
  }
}

function beep(freq, duration, when) {
  // Self-heal every call: some browsers silently suspend the AudioContext
  // again (e.g. after a phone screen locks mid-workout), and without this
  // every beep after that point would be scheduled but never actually heard.
  ensureAudio();
  if (!audioCtx) return null;
  const startAt = when != null ? when : audioCtx.currentTime;
  const osc = audioCtx.createOscillator();
  const gain = audioCtx.createGain();
  osc.type = 'sine';
  osc.frequency.value = freq;
  osc.connect(gain);
  gain.connect(audioCtx.destination);
  gain.gain.setValueAtTime(0.0001, startAt);
  gain.gain.exponentialRampToValueAtTime(0.3, startAt + 0.005);
  gain.gain.exponentialRampToValueAtTime(0.0001, startAt + duration);
  osc.start(startAt);
  osc.stop(startAt + duration + 0.02);
  const entry = { osc, gain };
  osc.onended = () => {
    osc.disconnect();
    gain.disconnect();
    const i = pendingCadenceBeeps.indexOf(entry);
    if (i >= 0) pendingCadenceBeeps.splice(i, 1);
  };
  return entry;
}

// Stroke beeps that have been scheduled ahead of time but haven't played
// yet - kept so they can be cancelled if the user pauses/skips/stops before
// they land (otherwise a beep scheduled for the old position would still
// fire after jumping elsewhere).
let pendingCadenceBeeps = [];
function cancelPendingCadenceBeeps() {
  if (!audioCtx) {
    pendingCadenceBeeps = [];
    return;
  }
  const now = audioCtx.currentTime;
  for (const { osc, gain } of pendingCadenceBeeps) {
    try {
      gain.gain.cancelScheduledValues(now);
      gain.gain.setValueAtTime(0.0001, now);
      osc.stop(now + 0.01);
    } catch (e) {
      // Already stopped/ended - fine to ignore.
    }
  }
  pendingCadenceBeeps = [];
}

// Given a position within a stage's stroke cycle, finds the next drive/
// recover boundary (stage-relative seconds) strictly after it.
function nextStrokeBoundary(stageElapsed, period, driveDur) {
  const cyclePos = stageElapsed % period;
  if (cyclePos < driveDur - 1e-9) {
    return stageElapsed - cyclePos + driveDur; // upcoming recover start
  }
  return stageElapsed - cyclePos + period; // upcoming drive start (next cycle)
}

const CADENCE_LOOKAHEAD_SECONDS = 0.2;
const CADENCE_SCHEDULER_INTERVAL_MS = 25;
let cadenceSchedulerTimer = null;
let scheduledUpToElapsed = 0;

function startAudioScheduler() {
  scheduledUpToElapsed = getElapsed(performance.now());
  if (cadenceSchedulerTimer) return;
  cadenceSchedulerTimer = setInterval(cadenceSchedulerTick, CADENCE_SCHEDULER_INTERVAL_MS);
}

function stopAudioScheduler() {
  if (cadenceSchedulerTimer) {
    clearInterval(cadenceSchedulerTimer);
    cadenceSchedulerTimer = null;
  }
}

function cadenceSchedulerTick() {
  if (!running || !workout || !audioCtx) return;
  const nowPerf = performance.now();
  const elapsedNow = getElapsed(nowPerf);
  if (elapsedNow >= totalDuration) return;
  if (scheduledUpToElapsed < elapsedNow) scheduledUpToElapsed = elapsedNow;

  const lookaheadElapsed = elapsedNow + CADENCE_LOOKAHEAD_SECONDS;
  let guard = 0;
  while (scheduledUpToElapsed < lookaheadElapsed && guard++ < 50) {
    const idx = getCurrentStageIndex(scheduledUpToElapsed);
    const stage = workout.stages[idx];
    const stageStart = cumulative[idx];
    const stageEnd = stageStart + stage.duration;

    if (stage.spm <= 0) {
      scheduledUpToElapsed = stageEnd; // rest stages have no cadence beeps
      continue;
    }

    const period = 60 / stage.spm;
    const driveRatio = stage.driveRatio != null ? stage.driveRatio : driveFractionForSpm(stage.spm);
    const driveDur = period * driveRatio;
    const anchor = cadenceCycleStart(stageStart);
    const cadenceElapsedPtr = Math.max(0, scheduledUpToElapsed - anchor);
    const cyclePos = cadenceElapsedPtr % period;
    const phaseAtBoundary = cyclePos < driveDur ? 'recover' : 'drive';
    const boundaryFromAnchor = nextStrokeBoundary(cadenceElapsedPtr, period, driveDur);
    const eventElapsed = anchor + boundaryFromAnchor;

    if (eventElapsed >= stageEnd) {
      scheduledUpToElapsed = stageEnd; // boundary belongs to the next stage
      continue;
    }
    if (eventElapsed > lookaheadElapsed) break; // nothing more to do this tick

    const perfAtEvent = runStartPerf + (eventElapsed - runOffset) * 1000;
    const audioTime = audioTimeFromPerf(perfAtEvent);
    const freq = phaseAtBoundary === 'drive' ? 880 : 440;
    const entry = beep(freq, 0.09, audioTime);
    if (entry) pendingCadenceBeeps.push(entry);
    scheduledUpToElapsed = eventElapsed + 1e-6;
  }
}

// --- Controls -------------------------------------------------------------

// Real Fullscreen API request, best-effort - works on Android Chrome/desktop
// browsers for a plain (non-installed) tab. iOS Safari doesn't support the
// Fullscreen API at all; there, "Add to Home Screen" (via manifest.json's
// display:fullscreen + the apple-mobile-web-app meta tags) is what gets rid
// of the browser chrome instead. Never throws - it's a nice-to-have, not
// something that should ever break the Play button.
function requestFullscreenBestEffort() {
  const el = document.documentElement;
  const request = el.requestFullscreen || el.webkitRequestFullscreen;
  if (!request || document.fullscreenElement) return;
  request.call(el).catch(() => {});
}

els.btnPlayPause.addEventListener('click', () => {
  if (!workout) return;
  ensureAudio();
  requestFullscreenBestEffort();
  const now = performance.now();

  if (countdownActive) {
    // Tapped again during the get-ready countdown - cancel back to paused.
    countdownActive = false;
    countdownStartPerf = null;
    els.countdownOverlay.hidden = true;
    return;
  }

  if (running) {
    runOffset = getElapsed(now); // must capture the live position before flipping `running`
    running = false;
    runStartPerf = null;
    stopAudioScheduler();
    cancelPendingCadenceBeeps();
    releaseWakeLock();
    return;
  }

  if (getElapsed(now) >= totalDuration) return;
  countdownActive = true;
  countdownStartPerf = now;
  last.countdownShown = null;
  els.countdownNumber.textContent = String(COUNTDOWN_SECONDS);
  els.countdownOverlay.hidden = false;
});

els.btnStop.addEventListener('click', () => {
  if (!workout) return;
  running = false;
  hasStarted = false;
  countdownActive = false;
  countdownStartPerf = null;
  els.countdownOverlay.hidden = true;
  runOffset = 0;
  runStartPerf = null;
  stopAudioScheduler();
  cancelPendingCadenceBeeps();
  releaseWakeLock();
});

els.btnNext.addEventListener('click', () => {
  if (!workout) return;
  const now = performance.now();
  const idx = getCurrentStageIndex(getElapsed(now));
  const target = idx < workout.stages.length - 1 ? cumulative[idx + 1] : totalDuration;
  setElapsed(target, now);
  cancelPendingCadenceBeeps();
  if (running) scheduledUpToElapsed = getElapsed(now);
});

els.btnPrev.addEventListener('click', () => {
  if (!workout) return;
  const now = performance.now();
  const elapsed = getElapsed(now);
  const idx = getCurrentStageIndex(elapsed);
  const stageElapsed = elapsed - cumulative[idx];
  const target = stageElapsed > 3 || idx === 0 ? cumulative[idx] : cumulative[idx - 1];
  setElapsed(target, now);
  cancelPendingCadenceBeeps();
  if (running) scheduledUpToElapsed = getElapsed(now);
});

els.settingsBtn.addEventListener('click', () => {
  els.settingsPanel.hidden = false;
});
els.settingsClose.addEventListener('click', () => {
  els.settingsPanel.hidden = true;
});

els.fileInput.addEventListener('change', (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const data = JSON.parse(reader.result);
      loadWorkout(data);
      els.workoutSelect.value = '';
      els.settingsPanel.hidden = true;
    } catch (err) {
      alert('Kon JSON-bestand niet lezen: ' + err.message);
    }
  };
  reader.readAsText(file);
});

els.btnLoadExample.addEventListener('click', () => {
  loadWorkout(DEFAULT_WORKOUT);
  els.workoutSelect.value = '';
  els.settingsPanel.hidden = true;
});

// Populate the "load from library" dropdown from workouts/index.json, so the
// list of available workouts lives in one place (that manifest) instead of
// being hard-coded here. Fails quietly if unavailable (e.g. opened via
// file:// rather than a real server) - the file-picker and example button
// still work either way.
fetch('workouts/index.json')
  .then((r) => r.json())
  .then((entries) => {
    for (const entry of entries) {
      const option = document.createElement('option');
      option.value = entry.file;
      option.textContent = entry.name;
      els.workoutSelect.appendChild(option);
    }
  })
  .catch(() => {
    // No manifest reachable - leave the dropdown as just the placeholder.
  });

els.workoutSelect.addEventListener('change', () => {
  const file = els.workoutSelect.value;
  if (!file) return;
  fetch('workouts/' + file)
    .then((r) => {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    })
    .then((data) => {
      loadWorkout(data);
      els.settingsPanel.hidden = true;
    })
    .catch((err) => {
      alert('Kon workout niet laden: ' + err.message);
      els.workoutSelect.value = '';
    });
});

// Load instantly from the embedded default - no network round-trip needed,
// so the page is fully usable the moment it's opened (online or offline).
loadWorkout(DEFAULT_WORKOUT);

// Precache the app shell and workout library so the app keeps working with
// no signal at all (e.g. a basement gym) once it's been opened once.
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  });
}

// The layout is tuned for landscape (bigger gauge, roomier controls), so
// nudge toward rotating - but portrait works fine too, so this is a
// dismissible hint, not a hard block. Dismissing it holds for the rest of
// the browser session; it comes back if you reopen the app later.
const portraitQuery = window.matchMedia('(orientation: portrait)');
let rotateBannerDismissed = sessionStorage.getItem('rotateBannerDismissed') === '1';
function updateRotateBanner() {
  els.rotateBanner.hidden = rotateBannerDismissed || !portraitQuery.matches;
}
portraitQuery.addEventListener('change', updateRotateBanner);
els.rotateBannerClose.addEventListener('click', () => {
  rotateBannerDismissed = true;
  sessionStorage.setItem('rotateBannerDismissed', '1');
  updateRotateBanner();
});
updateRotateBanner();
