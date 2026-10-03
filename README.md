<p align="center">
  <img src="assets/icons/icon-192.png" width="96" height="96" alt="Ritim app icon">
</p>

<h1 align="center">Ritim</h1>

<p align="center">
  A mobile-first tracker for things that repeat: medication, habits, chores and bills.<br>
  Finished tasks aren't deleted. They come back every day, week, month or year.
</p>

<p align="center">
  <a href="https://yavuzkrm.github.io/ritim/"><strong>Open the app →</strong></a>
  &nbsp;·&nbsp; Turkish interface &nbsp;·&nbsp; Free, no sign-up server, works offline
</p>

> [!NOTE]
> **This is a vibe-coded project.** All of the code, the visual design and this README were written by an AI (Anthropic's Claude, working in Claude Code) from plain-language requests in Turkish. My part was describing what I wanted, trying each version on my phone and asking for changes. I did not write the code and I have not reviewed it line by line. It ships with an automated end-to-end test suite, but please treat it as a personal hobby project, not audited software.

> [!WARNING]
> **Ritim is not a medical device.** Don't rely on it as your only medication reminder. Reminders only appear while the app is open or running in the background, and data lives in your browser, so clearing site data deletes it unless you have a backup.

<p align="center">
  <img src="assets/screenshots/today.png" width="24%" alt="Today screen with a weekly pill-box strip, progress ring and tasks grouped by time of day">
  <img src="assets/screenshots/add-task.png" width="24%" alt="Adding a task: name, how often it repeats, and at what times">
  <img src="assets/screenshots/progress.png" width="24%" alt="Progress screen with completion rates, a 14-day bar chart and a heatmap">
  <img src="assets/screenshots/today-dark.png" width="24%" alt="Today screen in dark mode">
</p>

## Why

A normal to-do list wants you to tick a task off and forget it. Taking a pill twice a day, watering plants every three days or paying a bill on the 15th doesn't work that way. Ritim keeps those tasks in place and asks you again each time they are due. It was also built so that older family members can use it: big text, strong contrast and a word next to every icon.

## Features

**Schedules**
- Every day, or every *N* days
- Chosen weekdays (Mon / Wed / Fri, weekdays only, weekends), optionally every *N* weeks
- A day of the month, including "last day of the month"; day 31 falls back gracefully in short months
- Yearly (birthdays, annual check-ups), and one-off tasks that show as overdue until done
- Several times a day. Each dose is checked off separately
- Optional start and end dates ("antibiotic for 7 days")

**Daily use**
- *Today* screen with a weekly pill-organizer strip, a progress ring and morning / afternoon / evening / night groups
- A clear **Yaptım** ("Done") button on every task, the time it was done, and a red warning when a time has passed
- Streaks per task plus a "perfect day" streak; skipping a day doesn't break it
- Medication stock: counts down with each dose, warns when it runs low and estimates how many days are left
- Important (starred) tasks, categories with colors and icons, pause, undo after delete
- In-app reminders when a task's time arrives, plus system notifications if you allow them

**Overview**
- Month calendar showing how complete each day was
- Task list with search and filters
- Progress page: 7- and 30-day completion, a 14-day chart, an 18-week heatmap, your most and least consistent weekday, per-task rates

**Comfort and accessibility**
- Text size setting (Normal / Large / Extra large) that scales the whole interface
- Large touch targets, high-contrast colors, labelled buttons
- Light and dark themes, six accent colors

**Your data**
- Local accounts with username and password, plus a one-time recovery code for resetting a forgotten password
- JSON backup and restore for moving to a new phone
- Installable as an app (PWA) and usable offline

## Use it on your phone

1. Open **https://yavuzkrm.github.io/ritim/** on the phone.
2. Add it to the home screen:
   - **Android (Chrome):** menu ⋮ → *Add to Home screen* / *Install app*
   - **iPhone (Safari):** Share → *Add to Home Screen*
3. Create an account and add your first task, or tap *Örnek görevlerle dene* to start with examples.

Each phone keeps its own data. To move to another device, use **Ayarlar → Yedeği indir** on the old one and **Yedekten geri yükle** on the new one.

## How it works

- **One file.** The whole app is [`src/app.html`](src/app.html): HTML, CSS and vanilla JavaScript, with no framework and no runtime dependencies besides Google Fonts.
- **No server.** On GitHub Pages everything is stored in the browser's `localStorage`. The same file also runs as a [claude.ai](https://claude.ai) artifact, where it uses the artifact's per-user database to sync between devices.
- **Passwords** are hashed in the browser with PBKDF2-SHA256 (120,000 iterations, random salt per account). This keeps casual users of a shared phone out of each other's lists. It is not server-grade security, because anyone with access to the browser's storage can read the task data itself.
- **Offline.** A small service worker caches the app; the page is fetched network-first so updates still arrive.
- **Build.** [`scripts/build.js`](scripts/build.js) wraps the fragment in a full HTML document and writes `docs/` with the web app manifest, service worker and icons. GitHub Pages serves `docs/` from the `main` branch.

## Project structure

```
.
├── src/
│   └── app.html            # the entire app (single-file source of truth)
├── docs/                   # built site served by GitHub Pages (generated)
├── scripts/
│   ├── build.js            # src/app.html → docs/ (manifest, service worker, icons)
│   ├── make-icons.js       # renders the app icons with headless Chrome
│   └── screenshots.js      # captures the README screenshots
├── tests/
│   ├── e2e.js              # end-to-end tests in a phone-sized headless Chrome
│   └── browser.js          # finds Chrome and serves docs/ locally
├── assets/
│   ├── icons/              # app icons (pill-organizer motif)
│   └── screenshots/        # images used in this README
├── package.json
└── LICENSE
```

## Development

Requirements: Node.js 18+ and Google Chrome or Microsoft Edge. Set `CHROME_PATH` if the browser isn't found automatically.

```bash
npm install          # installs puppeteer-core (dev only)
npm run build        # src/app.html → docs/
npm test             # 39 end-to-end checks against docs/
npm run screenshots  # refresh assets/screenshots/
npm run icons        # re-render assets/icons/
```

The tests sign up, add and complete tasks, check the recurrence rules (last day of month, every 2 weeks, leap years, DST), look for layout overflow at the largest text size, sign out and back in, reload offline, and reset a password with the recovery code.

## Known limitations

- No sync between devices on the GitHub Pages version; use backup and restore.
- Reminders need the app to be open or in the background. There is no push server, so a fully closed app can't notify you.
- The interface is in Turkish only.

## How this was made

Ritim was built in one long conversation with Claude Code. The process, roughly:

1. I asked for a to-do app with repeating tasks (like medication) that works on a phone and has user login, with "many good features and a good design".
2. Claude built the first version, tested it in a headless browser and published it.
3. I asked for a simpler design. The minimal redesign it made looked worse, so we went back to the original look.
4. Because older people will use it, the next pass made the text larger, raised the contrast, added a text-size setting and turned the editor into plain-language choices.
5. Feedback from real use followed: an explicit "Done" button instead of an empty circle, clearer "important" marking, an "is this important?" question when adding a task, and a fix for scrolling on small screens.
6. Finally it was packaged for free hosting on GitHub Pages, with offline support, icons and this README.

If you find a bug, feel free to open an issue. Fixes will most likely be vibe-coded too.

## License

[MIT](LICENSE) © 2026 Yavuz Kerem Ataç
