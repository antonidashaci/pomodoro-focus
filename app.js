/**
 * UI for Pomodoro Focus. The timer logic is in core.js.
 */
import {
  DEFAULT_SETTINGS, PHASE_LABELS, advance, catchUp, createTimer, formatDuration,
  logSession, pause, phaseDuration, progress, remaining, reset, start, streak,
} from './core.js';

const STORAGE_KEY = 'pomodoro-focus/v1';
const RING_LENGTH = 2 * Math.PI * 54;

// sound and notify are UI preferences, not timer rules, so they live here
// rather than in core.js's DEFAULT_SETTINGS.
let settings = { ...DEFAULT_SETTINGS, sound: true, notify: false };
let timer = createTimer(settings);
/** @type {{date: string, minutes: number, sessions: number}[]} */
let history = [];

const el = {};
for (const id of [
  'phase', 'clock', 'ring', 'rounds', 'toggle', 'reset', 'skip', 'caught-up',
  'stat-sessions', 'stat-minutes', 'stat-streak', 'stat-total', 'chart',
  'focusMinutes', 'shortBreakMinutes', 'longBreakMinutes', 'roundsPerCycle',
  'autoStartBreaks', 'autoStartFocus', 'sound', 'notify', 'clear-history',
]) {
  el[id] = document.getElementById(id);
}

const NUMBER_FIELDS = ['focusMinutes', 'shortBreakMinutes', 'longBreakMinutes', 'roundsPerCycle'];
const FLAG_FIELDS = ['autoStartBreaks', 'autoStartFocus', 'sound', 'notify'];

function load() {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null');
    if (!parsed) return;
    settings = { ...DEFAULT_SETTINGS, sound: true, notify: false, ...parsed.settings };
    history = Array.isArray(parsed.history) ? parsed.history.filter((d) => d?.date) : [];
    if (parsed.timer?.phase) {
      timer = { ...createTimer(settings), ...parsed.timer };
      // A timer saved as running has a real endsAt, so a reload picks up where
      // it left off instead of restarting the phase.
      const result = catchUp(timer, settings);
      timer = result.state;
      if (result.completed.length) {
        reportCaughtUp(result.completed);
      }
    }
  } catch {
    // Corrupt storage: start clean rather than refusing to load.
  }
}

function save() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ settings, timer, history }));
  } catch {
    // Private mode or a full quota.
  }
}

function readSettings() {
  for (const key of NUMBER_FIELDS) {
    const value = Number(el[key].value);
    if (Number.isFinite(value) && value >= 1) settings[key] = value;
  }
  for (const key of FLAG_FIELDS) settings[key] = el[key].checked;
}

function writeSettings() {
  for (const key of NUMBER_FIELDS) el[key].value = settings[key];
  for (const key of FLAG_FIELDS) el[key].checked = Boolean(settings[key]);
}

/* ---------- chime ---------- */

let audio;
function chime() {
  if (!settings.sound) return;
  try {
    audio ??= new (window.AudioContext ?? window.webkitAudioContext)();
    // A couple of short sine notes. A bundled mp3 for one beep is 40 kB of
    // network for something the browser can already synthesise.
    const now = audio.currentTime;
    for (const [index, frequency] of [880, 1320].entries()) {
      const oscillator = audio.createOscillator();
      const gain = audio.createGain();
      oscillator.frequency.value = frequency;
      oscillator.type = 'sine';
      gain.gain.setValueAtTime(0, now + index * 0.18);
      gain.gain.linearRampToValueAtTime(0.22, now + index * 0.18 + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + index * 0.18 + 0.16);
      oscillator.connect(gain).connect(audio.destination);
      oscillator.start(now + index * 0.18);
      oscillator.stop(now + index * 0.18 + 0.18);
    }
  } catch {
    // Autoplay policy, or no AudioContext. Not worth telling anyone about.
  }
}

function notify(finished, started) {
  if (!settings.notify || globalThis.Notification?.permission !== 'granted') return;
  try {
    new Notification(`${PHASE_LABELS[finished]} finished`, {
      body: `${PHASE_LABELS[started]} is next.`,
      tag: 'pomodoro-focus',
    });
  } catch {
    // Some browsers only allow notifications from a service worker.
  }
}

function reportCaughtUp(completed) {
  const focus = completed.filter((phase) => phase === 'focus').length;
  el['caught-up'].textContent = focus
    ? `${focus} focus session${focus === 1 ? '' : 's'} finished while this tab was in the background.`
    : 'A break finished while this tab was in the background.';
}

/* ---------- rendering ---------- */

function renderTimer() {
  const left = remaining(timer);
  const label = PHASE_LABELS[timer.phase];

  el.clock.textContent = formatDuration(left);
  el.phase.textContent = label;
  document.body.dataset.phase = timer.phase;
  document.title = `${formatDuration(left)} · ${label}`;

  el.ring.style.strokeDasharray = String(RING_LENGTH);
  el.ring.style.strokeDashoffset = String(RING_LENGTH * (1 - progress(timer, settings)));

  el.toggle.textContent = timer.running ? 'Pause' : 'Start';
  el.toggle.setAttribute('aria-label', timer.running ? 'Pause the timer' : 'Start the timer');

  const rounds = Math.max(1, Math.round(settings.roundsPerCycle));
  el.rounds.textContent = Array.from({ length: rounds },
    (_, i) => (i < timer.completedFocus ? '●' : '○')).join(' ');
}

function todayKey(date = new Date()) {
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0'),
  ].join('-');
}

function renderStats() {
  const today = history.find((day) => day.date === todayKey());
  el['stat-sessions'].textContent = String(today?.sessions ?? 0);
  el['stat-minutes'].textContent = `${today?.minutes ?? 0}m`;
  const days = streak(history);
  el['stat-streak'].textContent = `${days} day${days === 1 ? '' : 's'}`;
  el['stat-total'].textContent = String(history.reduce((sum, day) => sum + day.sessions, 0));

  const last14 = [];
  for (let offset = 13; offset >= 0; offset -= 1) {
    const date = new Date();
    date.setDate(date.getDate() - offset);
    const key = todayKey(date);
    last14.push({ key, date, day: history.find((d) => d.date === key) });
  }
  const peak = Math.max(1, ...last14.map((entry) => entry.day?.sessions ?? 0));

  el.chart.replaceChildren(...last14.map(({ key, date, day }) => {
    const li = document.createElement('li');
    const sessions = day?.sessions ?? 0;

    const bar = document.createElement('div');
    bar.className = sessions ? 'bar' : 'bar empty';
    bar.style.height = `${Math.round((sessions / peak) * 100)}%`;
    bar.title = `${key}: ${sessions} session${sessions === 1 ? '' : 's'}`;

    const caption = document.createElement('div');
    caption.className = 'day';
    caption.textContent = String(date.getDate());

    li.append(bar, caption);
    return li;
  }));
}

function renderAll() {
  renderTimer();
  renderStats();
  save();
}

/* ---------- the loop ---------- */

/**
 * Repaint only. The display is derived from the clock, so a late or skipped
 * frame changes nothing about correctness.
 */
function tick() {
  if (timer.running && remaining(timer) <= 0) {
    const result = advance(timer, settings);
    if (result.finished === 'focus') {
      history = logSession(history, { minutes: Math.round(phaseDuration(settings, 'focus') / 60000) });
    }
    timer = result.state;
    chime();
    notify(result.finished, result.started);
    el['caught-up'].textContent = '';
    renderAll();
    return;
  }
  renderTimer();
}

setInterval(tick, 250);

document.addEventListener('visibilitychange', () => {
  if (document.hidden) return;
  const result = catchUp(timer, settings);
  if (result.completed.length) {
    for (const phase of result.completed) {
      if (phase === 'focus') {
        history = logSession(history, {
          minutes: Math.round(phaseDuration(settings, 'focus') / 60000),
        });
      }
    }
    timer = result.state;
    reportCaughtUp(result.completed);
  }
  renderAll();
});

/* ---------- events ---------- */

el.toggle.addEventListener('click', () => {
  timer = timer.running ? pause(timer) : start(timer);
  el['caught-up'].textContent = '';
  renderAll();
});

el.reset.addEventListener('click', () => {
  timer = reset(timer, settings);
  renderAll();
});

el.skip.addEventListener('click', () => {
  timer = advance(timer, settings, { skipped: true }).state;
  renderAll();
});

for (const key of NUMBER_FIELDS) {
  el[key].addEventListener('change', () => {
    readSettings();
    // A phase that is not running should pick up the new length immediately.
    if (!timer.running) timer = reset(timer, settings);
    renderAll();
  });
}

for (const key of ['autoStartBreaks', 'autoStartFocus', 'sound']) {
  el[key].addEventListener('change', () => {
    readSettings();
    save();
  });
}

el.notify.addEventListener('change', async () => {
  if (el.notify.checked && !globalThis.Notification) {
    el.notify.checked = false;
  } else if (el.notify.checked && globalThis.Notification.permission === 'default') {
    const permission = await globalThis.Notification.requestPermission();
    if (permission !== 'granted') el.notify.checked = false;
  }
  readSettings();
  save();
});

el['clear-history'].addEventListener('click', () => {
  if (!confirm('Delete all session history in this browser?')) return;
  history = [];
  renderAll();
});

document.addEventListener('keydown', (event) => {
  if (event.target instanceof HTMLInputElement) return;
  if (event.code === 'Space') {
    event.preventDefault();
    el.toggle.click();
  }
});

load();
writeSettings();
renderAll();
