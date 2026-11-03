# Pomodoro Focus

A pomodoro timer that is still correct after the tab has been in the background
for an hour. Local-first, no dependencies, no build step.

## Run it

```bash
python -m http.server 8000
```

Or open `index.html`.

## The bug this is built to avoid

The usual implementation counts down a variable inside
`setInterval(…, 1000)`. That breaks in three ways at once:

- browsers throttle background-tab timers to roughly once a minute, or stop
  them entirely
- phones suspend them when the screen locks
- the callback is never exactly 1000 ms apart, so error accumulates even in the
  foreground

A 25-minute pomodoro in a background tab finishes several minutes late.

**Nothing here counts ticks.** A running timer stores the wall-clock instant it
will end, and `remaining()` subtracts. The interval only repaints the display —
if it fires late, or not at all, the numbers are still right. There's a test
that asserts exactly this.

Coming back after a long absence, `catchUp()` settles every phase whose time ran
out while you were away, and the page says what you missed:

```
2 focus sessions finished while this tab was in the background.
```

The same thing happens on reload, so closing the tab mid-session doesn't restart
the phase.

## Features

- Focus / short break / long break with a configurable cycle
- Progress ring, title-bar countdown, Space to start and pause
- Today's sessions and minutes, a day streak, and a 14-day bar chart
- A synthesised chime (no 40 kB mp3 for one beep) and optional desktop
  notifications
- Everything in `localStorage`

## Two deliberate decisions

**Skipping doesn't count.** `advance(…, { skipped: true })` moves on without
incrementing the session count. Stats you can inflate by pressing Skip are
worth nothing.

**Sessions are filed against the local day.** A session finished at 01:00 in
Istanbul belongs to today; `toISOString()` would file it under yesterday and
silently break the streak. There's a test for that too.

## Layout

| | |
| --- | --- |
| `core.js` | the timer state machine, history and streak — no DOM |
| `app.js` | the UI |
| `index.html`, `styles.css`, `timer.css` | markup and styles, dark mode included |

## Tests

```bash
npm test
```

22 tests with `node --test`, driven by an injected clock: pausing, resuming, the
full cycle, auto-start, background catch-up, a clock jumped forward by a year,
and a zero-minute phase that must not loop forever.

## License

MIT
