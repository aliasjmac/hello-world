# SugarWOD schedule downloader

Logs into `app.sugarwod.com`, opens the weekly calendar, and saves the
workout data as JSON.

## Known limitation

This script was written without the ability to reach `app.sugarwod.com`
(network access to that domain was blocked in the environment it was
authored in), so the login form selectors and API-detection logic are
best-effort, not verified against the live site. It's very likely to need
a small tweak or two on first run — see Troubleshooting below.

## Setup

```
cd scripts/sugarwod
npm install
npx playwright install chromium   # first time only
```

## Usage

```
node download-schedule.js --week 20260629
```

You'll be prompted for your SugarWOD email and password (input is hidden;
nothing is written to disk). You can skip the prompts by setting
`SUGARWOD_EMAIL` and `SUGARWOD_PASSWORD` environment variables instead.

Options:

- `--week YYYYMMDD` — Monday of the week to fetch. Defaults to the
  current week.
- `--track NAME` — workout track, e.g. `workout-of-the-day` (default).
- `--out FILE` — output path. Defaults to `sugarwod-schedule-<week>.json`
  in the current directory.
- `--headed` — show the browser window instead of running headless.
  Useful for debugging the login flow.

## How it works

Rather than scraping rendered HTML (which breaks any time SugarWOD ships
a frontend change), the script listens for the JSON API calls the
SugarWOD app itself makes while the calendar page loads, and saves those
responses directly. The output file has this shape:

```json
{
  "week": "20260629",
  "track": "workout-of-the-day",
  "calendarUrl": "...",
  "fetchedAt": "...",
  "workouts": [ ... ],       // best-guess parsed workout list, or null
  "raw_responses": [ ... ]   // every captured API response, for reference
}
```

If `workouts` comes back `null`, open `raw_responses` and look for the
entry that contains the actual workout list — then either use it directly
or tell me what its shape looks like so the auto-detection can be
improved.

## Troubleshooting

- **Login fails / "Could not find a login form"**: run with `--headed` to
  watch the browser and see what the real login page looks like, then
  update the selectors in the `login()` function in
  `download-schedule.js`.
- **`workouts` is `null`**: check `raw_responses` in the output file for
  the request that actually contains the calendar data, and adjust the
  filter in the `page.on('response', ...)` handler if needed (e.g. it
  may need to match a URL on `api.sugarwod.com` rather than
  `app.sugarwod.com`).
- **Playwright can't find a browser**: run `npx playwright install
  chromium` in this directory.
