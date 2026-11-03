import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  DEFAULT_SETTINGS, advance, catchUp, createTimer, formatDuration, logSession,
  nextPhase, pause, phaseDuration, progress, remaining, reset, start, streak,
} from './core.js';

const S = { ...DEFAULT_SETTINGS, autoStartBreaks: false, autoStartFocus: false };
const T0 = 1_762_171_200_000; // a fixed instant
const MINUTE = 60_000;

test('a new timer is a stopped focus phase', () => {
  const timer = createTimer(S);
  assert.equal(timer.phase, 'focus');
  assert.equal(timer.running, false);
  assert.equal(remaining(timer, T0), 25 * MINUTE);
});

test('time comes from the clock, not from tick counting', () => {
  // This is the whole design: nothing decrements, so a throttled or missing
  // interval cannot make the timer wrong.
  let timer = start(createTimer(S), T0);
  assert.equal(remaining(timer, T0), 25 * MINUTE);
  assert.equal(remaining(timer, T0 + 10 * MINUTE), 15 * MINUTE);
  assert.equal(remaining(timer, T0 + 25 * MINUTE), 0);
  assert.equal(remaining(timer, T0 + 90 * MINUTE), 0); // never negative
});

test('pause keeps what was left, resume continues from there', () => {
  let timer = start(createTimer(S), T0);
  timer = pause(timer, T0 + 10 * MINUTE);
  assert.equal(timer.running, false);
  assert.equal(remaining(timer, T0 + 60 * MINUTE), 15 * MINUTE); // paused time does not count

  timer = start(timer, T0 + 60 * MINUTE);
  assert.equal(remaining(timer, T0 + 65 * MINUTE), 10 * MINUTE);
});

test('start and pause are idempotent', () => {
  const running = start(createTimer(S), T0);
  assert.equal(start(running, T0 + 5 * MINUTE).endsAt, running.endsAt);
  const stopped = pause(running, T0 + MINUTE);
  assert.deepEqual(pause(stopped, T0 + 9 * MINUTE), stopped);
});

test('reset returns to the start of the current phase', () => {
  let timer = start(createTimer(S), T0);
  timer = reset(pause(timer, T0 + 10 * MINUTE), S);
  assert.equal(remaining(timer, T0), 25 * MINUTE);
  assert.equal(timer.running, false);
});

test('the cycle is focus, short, focus, short, focus, short, focus, long', () => {
  let timer = createTimer(S);
  const seen = [];
  for (let i = 0; i < 8; i += 1) {
    const result = advance(timer, S, { now: T0 });
    seen.push(result.started);
    timer = result.state;
  }
  assert.deepEqual(seen, [
    'shortBreak', 'focus', 'shortBreak', 'focus',
    'shortBreak', 'focus', 'longBreak', 'focus',
  ]);
  assert.equal(timer.totalFocus, 4);
});

test('nextPhase respects roundsPerCycle', () => {
  const two = { ...S, roundsPerCycle: 2 };
  let timer = createTimer(two);
  assert.equal(nextPhase(timer, two), 'shortBreak');
  timer = advance(advance(timer, two, { now: T0 }).state, two, { now: T0 }).state;
  assert.equal(nextPhase(timer, two), 'longBreak');
});

test('a skipped focus session does not count', () => {
  const done = advance(createTimer(S), S, { now: T0 });
  assert.equal(done.state.totalFocus, 1);

  const skipped = advance(createTimer(S), S, { now: T0, skipped: true });
  assert.equal(skipped.state.totalFocus, 0);
  assert.equal(skipped.state.completedFocus, 0);
  assert.equal(skipped.started, 'shortBreak');
});

test('skipping a break costs nothing', () => {
  const afterFocus = advance(createTimer(S), S, { now: T0 }).state;
  const result = advance(afterFocus, S, { now: T0, skipped: true });
  assert.equal(result.started, 'focus');
  assert.equal(result.state.totalFocus, 1);
});

test('auto-start settings are honoured', () => {
  const auto = { ...S, autoStartBreaks: true, autoStartFocus: false };
  const toBreak = advance(createTimer(auto), auto, { now: T0 });
  assert.equal(toBreak.state.running, true);
  assert.equal(toBreak.state.endsAt, T0 + 5 * MINUTE);

  const toFocus = advance(toBreak.state, auto, { now: T0 });
  assert.equal(toFocus.state.running, false);
  assert.equal(toFocus.state.endsAt, null);
});

test('catchUp settles a tab that was in the background', () => {
  const auto = { ...DEFAULT_SETTINGS, autoStartBreaks: true, autoStartFocus: true };
  const timer = start(createTimer(auto), T0);

  // Come back an hour later: focus, break, focus should all have finished.
  const result = catchUp(timer, auto, T0 + 60 * MINUTE);
  assert.ok(result.completed.length >= 2, JSON.stringify(result.completed));
  assert.equal(result.completed[0], 'focus');
  assert.ok(remaining(result.state, T0 + 60 * MINUTE) > 0);
  assert.equal(result.state.totalFocus, result.completed.filter((p) => p === 'focus').length);
});

test('catchUp stops at a phase that does not auto-start', () => {
  const timer = start(createTimer(S), T0);
  const result = catchUp(timer, S, T0 + 60 * MINUTE);
  assert.deepEqual(result.completed, ['focus']);
  assert.equal(result.state.phase, 'shortBreak');
  assert.equal(result.state.running, false);
});

test('catchUp does nothing while time is left', () => {
  const timer = start(createTimer(S), T0);
  const result = catchUp(timer, S, T0 + 5 * MINUTE);
  assert.deepEqual(result.completed, []);
  assert.deepEqual(result.state, timer);
});

test('catchUp terminates even if the clock jumps a year', () => {
  const auto = { ...DEFAULT_SETTINGS, autoStartBreaks: true, autoStartFocus: true };
  const result = catchUp(start(createTimer(auto), T0), auto, T0 + 365 * 24 * 60 * MINUTE);
  assert.ok(result.completed.length <= 500);
});

test('a zero-minute phase cannot loop forever', () => {
  const broken = { ...S, focusMinutes: 0 };
  assert.equal(phaseDuration(broken, 'focus'), 1000);
  assert.equal(phaseDuration({ ...S, focusMinutes: 'x' }, 'focus'), 1000);
});

test('formatDuration', () => {
  assert.equal(formatDuration(25 * MINUTE), '25:00');
  assert.equal(formatDuration(65_000), '1:05');
  assert.equal(formatDuration(0), '0:00');
  assert.equal(formatDuration(-5), '0:00');
  assert.equal(formatDuration(3_600_000), '1:00:00');
  assert.equal(formatDuration(3_905_000), '1:05:05');
});

test('progress goes 0 to 1', () => {
  const timer = start(createTimer(S), T0);
  assert.equal(progress(timer, S, T0), 0);
  assert.equal(progress(timer, S, T0 + 12.5 * MINUTE), 0.5);
  assert.equal(progress(timer, S, T0 + 25 * MINUTE), 1);
  assert.equal(progress(timer, S, T0 + 90 * MINUTE), 1);
});

test('sessions are logged against the local day, not UTC', () => {
  // 01:00 local belongs to today; toISOString() would file it as yesterday
  // anywhere east of Greenwich.
  const at = new Date(2026, 10, 3, 1, 0).getTime();
  const [day] = logSession([], { minutes: 25, at });
  assert.equal(day.date, '2026-11-03');
  assert.equal(day.sessions, 1);
  assert.equal(day.minutes, 25);
});

test('logging twice in a day accumulates', () => {
  const at = new Date(2026, 10, 3, 9, 0).getTime();
  let history = logSession([], { minutes: 25, at });
  history = logSession(history, { minutes: 25, at: at + 3600_000 });
  assert.equal(history.length, 1);
  assert.equal(history[0].sessions, 2);
  assert.equal(history[0].minutes, 50);
});

test('logSession does not mutate the history it was given', () => {
  const original = logSession([], { minutes: 25, at: Date.now() });
  const snapshot = JSON.stringify(original);
  logSession(original, { minutes: 25, at: Date.now() });
  assert.equal(JSON.stringify(original), snapshot);
});

test('history is capped at 90 days', () => {
  let history = [];
  for (let i = 0; i < 120; i += 1) {
    history = logSession(history, { minutes: 25, at: new Date(2026, 0, 1).getTime() + i * 86400000 });
  }
  assert.equal(history.length, 90);
  assert.ok(history[0].date < history[89].date); // oldest dropped, order kept
});

test('streak counts back from today and stops at a gap', () => {
  const today = new Date(2026, 10, 3);
  const day = (offset) => {
    const date = new Date(today);
    date.setDate(date.getDate() - offset);
    return {
      date: [date.getFullYear(), String(date.getMonth() + 1).padStart(2, '0'),
        String(date.getDate()).padStart(2, '0')].join('-'),
      sessions: 1,
      minutes: 25,
    };
  };

  assert.equal(streak([day(0), day(1), day(2)], today), 3);
  assert.equal(streak([day(0), day(2)], today), 1);   // gap at day 1
  assert.equal(streak([day(1), day(2)], today), 0);   // nothing today
  assert.equal(streak([], today), 0);
});
