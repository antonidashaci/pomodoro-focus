/**
 * A pomodoro timer that keeps correct time.
 *
 * The usual implementation counts down a variable in `setInterval(…, 1000)`.
 * Browsers throttle timers in background tabs to once a minute or stop them
 * altogether, phones suspend them on lock, and the callback is never exactly
 * 1000ms apart anyway - so a 25 minute pomodoro in a background tab finishes
 * several minutes late.
 *
 * So no state here counts ticks. A running timer stores the wall-clock instant
 * it will end, and `remaining()` subtracts. The interval exists only to repaint
 * the display; if it fires late, or not at all, the numbers are still right.
 */

export const DEFAULT_SETTINGS = {
  focusMinutes: 25,
  shortBreakMinutes: 5,
  longBreakMinutes: 15,
  /** Long break after this many focus sessions. */
  roundsPerCycle: 4,
  autoStartBreaks: true,
  autoStartFocus: false,
};

export const PHASES = ['focus', 'shortBreak', 'longBreak'];

const MINUTE = 60_000;

/** @param {typeof DEFAULT_SETTINGS} settings @param {string} phase */
export function phaseDuration(settings, phase) {
  const minutes = {
    focus: settings.focusMinutes,
    shortBreak: settings.shortBreakMinutes,
    longBreak: settings.longBreakMinutes,
  }[phase];
  // A zero-length phase would complete forever in a loop; one second is the floor.
  return Math.max(1000, Math.round((Number(minutes) || 0) * MINUTE));
}

/**
 * @typedef {object} TimerState
 * @property {string} phase            'focus' | 'shortBreak' | 'longBreak'
 * @property {number} completedFocus   focus sessions finished this cycle
 * @property {number} totalFocus       focus sessions finished since the reset
 * @property {number|null} endsAt       epoch ms, or null when not running
 * @property {number} leftoverMs        what was left when paused
 * @property {boolean} running
 */

/**
 * @param {typeof DEFAULT_SETTINGS} [settings]
 * @returns {TimerState}
 */
export function createTimer(settings = DEFAULT_SETTINGS) {
  return {
    phase: 'focus',
    completedFocus: 0,
    totalFocus: 0,
    endsAt: null,
    leftoverMs: phaseDuration(settings, 'focus'),
    running: false,
  };
}

/**
 * Milliseconds left, never negative.
 * @param {TimerState} state
 * @param {number} [now]
 */
export function remaining(state, now = Date.now()) {
  if (!state.running || state.endsAt === null) return Math.max(0, state.leftoverMs);
  return Math.max(0, state.endsAt - now);
}

/** @param {TimerState} state @param {number} [now] */
export function start(state, now = Date.now()) {
  if (state.running) return state;
  return { ...state, running: true, endsAt: now + Math.max(0, state.leftoverMs) };
}

/** @param {TimerState} state @param {number} [now] */
export function pause(state, now = Date.now()) {
  if (!state.running) return state;
  return { ...state, running: false, endsAt: null, leftoverMs: remaining(state, now) };
}

/** Back to the start of the current phase, stopped. */
export function reset(state, settings = DEFAULT_SETTINGS) {
  return {
    ...state,
    running: false,
    endsAt: null,
    leftoverMs: phaseDuration(settings, state.phase),
  };
}

/**
 * Which phase follows the current one.
 * @param {TimerState} state
 * @param {typeof DEFAULT_SETTINGS} settings
 */
export function nextPhase(state, settings = DEFAULT_SETTINGS) {
  if (state.phase !== 'focus') return 'focus';
  const rounds = Math.max(1, Math.round(Number(settings.roundsPerCycle) || 1));
  return (state.completedFocus + 1) % rounds === 0 ? 'longBreak' : 'shortBreak';
}

/**
 * Move to the next phase.
 *
 * @param {TimerState} state
 * @param {typeof DEFAULT_SETTINGS} settings
 * @param {{ now?: number, skipped?: boolean }} [options]
 *   A skipped phase does not count as completed, which is the point of
 *   tracking it: stats you can inflate by pressing Skip are worthless.
 * @returns {{ state: TimerState, finished: string, started: string }}
 */
export function advance(state, settings = DEFAULT_SETTINGS, options = {}) {
  const { now = Date.now(), skipped = false } = options;
  const finished = state.phase;
  const upcoming = nextPhase(state, settings);
  const countsAsDone = finished === 'focus' && !skipped;

  const rounds = Math.max(1, Math.round(Number(settings.roundsPerCycle) || 1));
  const completedFocus = countsAsDone
    ? (state.completedFocus + 1) % rounds
    : state.completedFocus;

  const autoStart = upcoming === 'focus' ? settings.autoStartFocus : settings.autoStartBreaks;
  const duration = phaseDuration(settings, upcoming);

  return {
    finished,
    started: upcoming,
    state: {
      phase: upcoming,
      completedFocus,
      totalFocus: state.totalFocus + (countsAsDone ? 1 : 0),
      leftoverMs: duration,
      running: Boolean(autoStart),
      endsAt: autoStart ? now + duration : null,
    },
  };
}

/**
 * Advance past every phase whose time ran out while the tab was hidden.
 *
 * Coming back to a backgrounded tab after an hour, a naive timer shows a
 * negative number or sits at zero. This settles the backlog and reports what
 * was missed, so the UI can say "2 sessions finished while you were away".
 *
 * @param {TimerState} state
 * @param {typeof DEFAULT_SETTINGS} settings
 * @param {number} [now]
 * @returns {{ state: TimerState, completed: string[] }}
 */
export function catchUp(state, settings = DEFAULT_SETTINGS, now = Date.now()) {
  let current = state;
  const completed = [];
  // Bounded: a phase is at least a second long, but cap the work anyway so a
  // clock jumped forward by a year cannot freeze the tab.
  for (let guard = 0; guard < 500; guard += 1) {
    if (!current.running || remaining(current, now) > 0) break;
    const at = current.endsAt ?? now;
    const result = advance(current, settings, { now: at });
    completed.push(result.finished);
    current = result.state;
    if (!current.running) break;
  }
  return { state: current, completed };
}

/** `25:00`, or `1:05:00` once it passes an hour. */
export function formatDuration(ms) {
  const total = Math.max(0, Math.round(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return hours
    ? `${hours}:${pad(minutes)}:${pad(seconds)}`
    : `${minutes}:${pad(seconds)}`;
}

/** 0 to 1, for a progress ring. */
export function progress(state, settings = DEFAULT_SETTINGS, now = Date.now()) {
  const duration = phaseDuration(settings, state.phase);
  return Math.min(1, Math.max(0, 1 - remaining(state, now) / duration));
}

export const PHASE_LABELS = {
  focus: 'Focus',
  shortBreak: 'Short break',
  longBreak: 'Long break',
};

/* ---------- history ---------- */

/**
 * Append a finished focus session to a log.
 * @param {{date: string, minutes: number, sessions: number}[]} history
 * @param {{ minutes: number, at?: number }} entry
 */
export function logSession(history, { minutes, at = Date.now() }) {
  const date = new Date(at);
  // Local date, not toISOString(): a session at 01:00 in Istanbul belongs to
  // today, and UTC would file it under yesterday.
  const key = [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0'),
  ].join('-');

  const next = history.map((day) => ({ ...day }));
  const today = next.find((day) => day.date === key);
  if (today) {
    today.minutes += minutes;
    today.sessions += 1;
  } else {
    next.push({ date: key, minutes, sessions: 1 });
  }
  return next.sort((a, b) => a.date.localeCompare(b.date)).slice(-90);
}

/**
 * Consecutive days with at least one session, counting back from today.
 * @param {{date: string, sessions: number}[]} history
 * @param {Date} [today]
 */
export function streak(history, today = new Date()) {
  const days = new Set(history.filter((day) => day.sessions > 0).map((day) => day.date));
  const cursor = new Date(today);
  let count = 0;
  for (let guard = 0; guard < 400; guard += 1) {
    const key = [
      cursor.getFullYear(),
      String(cursor.getMonth() + 1).padStart(2, '0'),
      String(cursor.getDate()).padStart(2, '0'),
    ].join('-');
    if (!days.has(key)) break;
    count += 1;
    cursor.setDate(cursor.getDate() - 1);
  }
  return count;
}
