#!/usr/bin/env node
/**
 * Download the weekly SugarWOD workout schedule.
 *
 * Logs into app.sugarwod.com, opens the calendar for a given week, and
 * saves the workout data it finds as JSON.
 *
 * Because SugarWOD is a JS single-page app, the most reliable way to get
 * structured data is to capture the JSON responses the app itself fetches
 * from its API while the calendar page loads, rather than scraping HTML
 * (which is brittle and changes with every frontend deploy). This script
 * does that: it records every JSON network response whose URL contains
 * "workout", and writes them all to the output file. If one of those
 * responses is clearly an array of workout records, it's also exposed
 * under the top-level "workouts" key for convenience.
 *
 * Usage:
 *   node download-schedule.js [--week YYYYMMDD] [--track workout-of-the-day]
 *                              [--out schedule.json] [--headed]
 *
 * Credentials are prompted for interactively and are never written to disk.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { chromium } = require('playwright');

const BASE_URL = 'https://app.sugarwod.com';

function parseArgs(argv) {
  const args = { week: null, track: 'workout-of-the-day', out: null, headed: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--week') args.week = argv[++i];
    else if (a === '--track') args.track = argv[++i];
    else if (a === '--out') args.out = argv[++i];
    else if (a === '--headed') args.headed = true;
    else if (a === '--help' || a === '-h') args.help = true;
  }
  return args;
}

function mondayOf(date) {
  const d = new Date(date);
  const day = d.getDay(); // 0 = Sunday
  const diff = (day === 0 ? -6 : 1) - day;
  d.setDate(d.getDate() + diff);
  return d;
}

function toYYYYMMDD(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}${m}${d}`;
}

function ask(query) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(query, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

// Masked password prompt. Falls back to plain (visible) input if stdin
// isn't a TTY (e.g. piped input), since raw mode isn't available then.
function askHidden(query) {
  if (!process.stdin.isTTY) {
    return ask(query);
  }
  return new Promise((resolve) => {
    process.stdout.write(query);
    let input = '';
    const stdin = process.stdin;
    stdin.resume();
    stdin.setRawMode(true);
    stdin.setEncoding('utf8');

    const CTRL_C = 3;
    const CTRL_D = 4;
    const BACKSPACE = 8;
    const DEL = 127;

    const onData = (char) => {
      const code = char.charCodeAt(0);
      if (char === '\n' || char === '\r' || code === CTRL_D) {
        stdin.setRawMode(false);
        stdin.removeListener('data', onData);
        stdin.pause();
        process.stdout.write('\n');
        resolve(input);
      } else if (code === CTRL_C) {
        process.stdout.write('\n');
        process.exit(1);
      } else if (code === DEL || code === BACKSPACE) {
        if (input.length > 0) {
          input = input.slice(0, -1);
          process.stdout.write('\b \b');
        }
      } else {
        input += char;
        process.stdout.write('*');
      }
    };
    stdin.on('data', onData);
  });
}

async function getCredentials() {
  const email = process.env.SUGARWOD_EMAIL || (await ask('SugarWOD email: '));
  const password = process.env.SUGARWOD_PASSWORD || (await askHidden('SugarWOD password: '));
  return { email, password };
}

// Try a list of selectors and return the first one present on the page.
async function firstMatchingSelector(page, selectors) {
  for (const sel of selectors) {
    const el = await page.$(sel);
    if (el) return sel;
  }
  return null;
}

async function login(page, email, password) {
  // SugarWOD may redirect an unauthenticated visit straight to a login
  // route, or render a login form in place. Try both a dedicated /login
  // URL and waiting for a form to show up wherever we land.
  await page.goto(`${BASE_URL}/login`, { waitUntil: 'domcontentloaded' }).catch(() => {});

  const emailSelectors = [
    'input[type="email"]',
    'input[name="email"]',
    '#email',
    'input[autocomplete="username"]',
  ];
  const passwordSelectors = [
    'input[type="password"]',
    'input[name="password"]',
    '#password',
  ];
  const submitSelectors = [
    'button[type="submit"]',
    'button:has-text("Log In")',
    'button:has-text("Sign In")',
    'input[type="submit"]',
  ];

  const emailSel = await firstMatchingSelector(page, emailSelectors);
  const passwordSel = await firstMatchingSelector(page, passwordSelectors);

  if (!emailSel || !passwordSel) {
    throw new Error(
      'Could not find a login form on the page. SugarWOD may have changed ' +
      'its login flow. Re-run with --headed to see what the browser sees, ' +
      'then update the selectors in login() in this script.'
    );
  }

  await page.fill(emailSel, email);

  // The password field can be present in the DOM but hidden until the
  // email step is submitted (a two-step "enter email, then password"
  // flow). If it's not visible yet, submit the email step first and wait
  // for the password field to appear before trying to fill it.
  const passwordAlreadyVisible = await page.isVisible(passwordSel).catch(() => false);
  if (!passwordAlreadyVisible) {
    const continueSelectors = [
      'button:has-text("Continue")',
      'button:has-text("Next")',
      'button[type="submit"]',
    ];
    const continueSel = await firstMatchingSelector(page, continueSelectors);
    if (continueSel) {
      await page.click(continueSel);
    } else {
      await page.keyboard.press('Enter');
    }
    await page.waitForSelector(passwordSel, { state: 'visible', timeout: 15000 });
  }

  await page.fill(passwordSel, password);

  const submitSel = await firstMatchingSelector(page, submitSelectors);
  if (submitSel) {
    await page.click(submitSel);
  } else {
    await page.keyboard.press('Enter');
  }

  // Give the SPA time to authenticate and redirect.
  await page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => {});
}

function looksLikeWorkoutArray(value) {
  if (!Array.isArray(value)) {
    // Some APIs wrap the array, e.g. { data: [...] }.
    if (value && typeof value === 'object' && Array.isArray(value.data)) {
      return true;
    }
    return false;
  }
  if (value.length === 0) return false;
  const sample = value[0];
  return sample && typeof sample === 'object';
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(
      'Usage: node download-schedule.js [--week YYYYMMDD] [--track workout-of-the-day] [--out schedule.json] [--headed]'
    );
    process.exit(0);
  }

  const week = args.week || toYYYYMMDD(mondayOf(new Date()));
  const outFile = args.out || path.join(process.cwd(), `sugarwod-schedule-${week}.json`);
  const calendarUrl = `${BASE_URL}/workouts/calendar?week=${week}&track=${encodeURIComponent(args.track)}`;

  const { email, password } = await getCredentials();

  console.log(`Launching browser (${args.headed ? 'headed' : 'headless'})...`);
  const browser = await chromium.launch({ headless: !args.headed });
  const page = await browser.newPage();

  const capturedResponses = [];
  page.on('response', async (response) => {
    const url = response.url();
    if (!/workout/i.test(url)) return;
    const contentType = response.headers()['content-type'] || '';
    if (!contentType.includes('json')) return;
    try {
      const body = await response.json();
      capturedResponses.push({ url, status: response.status(), body });
    } catch {
      // Non-JSON or empty body; ignore.
    }
  });

  try {
    console.log('Logging in...');
    await login(page, email, password);

    console.log(`Loading calendar: ${calendarUrl}`);
    await page.goto(calendarUrl, { waitUntil: 'networkidle', timeout: 30000 });
    // Extra settle time for any lazy-loaded API calls after initial render.
    await page.waitForTimeout(3000);
  } catch (err) {
    const shotPath = path.join(process.cwd(), `sugarwod-error-${week}.png`);
    await page.screenshot({ path: shotPath, fullPage: true }).catch(() => {});
    console.error(`Error: ${err.message}`);
    console.error(`Saved a screenshot for debugging: ${shotPath}`);
    await browser.close();
    process.exit(1);
  }

  await browser.close();

  const workoutsGuess = capturedResponses.find((r) => looksLikeWorkoutArray(r.body));

  const output = {
    week,
    track: args.track,
    calendarUrl,
    fetchedAt: new Date().toISOString(),
    workouts: workoutsGuess ? workoutsGuess.body : null,
    raw_responses: capturedResponses,
  };

  fs.writeFileSync(outFile, JSON.stringify(output, null, 2));
  console.log(`Saved ${capturedResponses.length} captured API response(s) to ${outFile}`);
  if (!workoutsGuess) {
    console.log(
      'Could not auto-detect a clear workout list among the captured responses. ' +
      'Inspect "raw_responses" in the output file to find the right one.'
    );
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
