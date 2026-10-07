# DB DPS Launcher

A launcher for Dungeon Blitz R with a damage meter built in. It opens the game in its own window, like the official launcher does, and shows a timer, your DPS, damage per spell, your rotation and a DPS graph in the grey space beside the game. It updates itself: when a new version is released here, the launcher downloads it in the background and offers to install it.

It's a separate program: it doesn't change the official Dungeon Blitz R launcher, and both can be installed side by side.

## Install

Download `DB-DPS-Launcher-Setup-x.y.z.exe` from [Releases](https://github.com/killssingkurisu/db-dpsmod/releases/latest) and run it. It installs for your Windows user only (no administrator rights), adds a desktop and Start-menu shortcut, and starts the launcher.

Windows may warn that the installer is from an unknown publisher, because it isn't code-signed. Choose *More info*, then *Run anyway*.

Flash Player comes with the launcher, so nothing else needs installing. Log in to the game the same way as in the official launcher.

## Updates

The launcher looks for a new release a few seconds after it starts and every hour after that. A new version downloads in the background; then the chip in the bottom-right corner turns gold (*Update 1.6.1 ready*) and a card offers **Restart and update**. Restarting closes the game for a few seconds and opens the new version. *Later* keeps playing; the update then installs when you close the launcher.

Click the chip any time for the launcher's menu: update status and *Check for updates*, reload the game (F5), full screen (F11), the exports folder, the log folder and this page.

## The damage meter

- **Damage Meter** (top left): a timer you start and stop (F6), reset (F7) and hide (F8); DPS, total damage, casts, hits and crit rate; **DPS over time**; **Scaling**: how much of your damage scales with Attack and how much with Expertise, how much came over time (DoTs) and from crits. A direct hit counts for the stat in its spell's Stats line ("1.49x attack"); every damage-over-time tick counts for Expertise, because the game puts your Expertise into each DoT when it lands.
- **Rotation** (under the Damage Meter): your casts in order as one line, like `MA2 s2 s3 RA1 s4 s1 MA2`. `s3` is the spell in hotbar slot 3 (s1 to s6 are keys 1, 2, 3, 4, E, Q); `MA` (melee attack) and `RA` (ranged attack) are basic attacks in a row, with the number of hits they landed. Hover any part for the spell, the time and its damage.
- **Spells** (top right): your hotbar spells by slot, each with its rank, share of your damage and casts; click one for its DPS, hits, crit rate, average and biggest hit, DoT damage and Stats line. Basic attacks, rune procs and pets are under *Other damage*.
- **Export…** to a JSON file (everything: spells, the rotation, every hit) or a CSV table for spreadsheets, and **Copy summary** for chat.

Drag any window by its title to move it, and resize it from its bottom-right corner; it stays where you put it. *Reset layout* (in the Damage Meter's status lines) puts them all back. Hits and casts only count while the timer runs; turn on *Start on first hit* to start it with your first hit. F8 (or ×) hides the windows and leaves a small *Damage Meter* tab in the top-left corner.

If you used the meter as a mod of the official launcher, its window layout and settings are copied over the first time this launcher starts.

### Spells from DB Inventory Scanner

The meter names every hit from the game's own data (it loads the server's `Game.swz`). Which spells are on your hotbar comes from [DB Inventory Scanner](https://github.com/killssingkurisu/db-inventory-scanner): open the Tome of Power, press **Scan spells**, and the meter picks the newest spell scan for your character up by itself. Without a scan it lists the spells you've used.

## How it reads your damage

The game client works out each hit's damage and sends it to the server: packet 0x0A for a hit and 0x79 for a damage-over-time tick; casts are packet 0x09. The launcher reads them on the way out:

1. The game website's plain-HTTP traffic goes through a small local proxy in the launcher, which passes every request on to the real site unchanged, except `DungeonBlitz.swf`: the copy handed to Flash logs in through `127.0.0.1` (two values changed: the login host and port). Flash's own sockets ignore Chromium's host rules, which is why the client itself is pointed at the launcher.
2. A relay on `127.0.0.1` forwards the client's bytes to the real login server as they arrive and reads a copy. "Enter world" (0x21), which names the server for the next level, is pointed at another relay, so every connection after login goes through the meter too. Flash's socket-policy requests are answered locally.
3. Training dummies: the game client works out DoT ticks on the house dummies but never sends them. The SWF the launcher serves sends them too, and the relay counts those ticks and keeps them from the server, so the server sees what an unmodified client sends.

Nothing on the server changes. Your hits are the ones whose attacker is your character or one of its summons. The server can add to your damage after it arrives (the Soulthief passive, admin damage scaling), so the meter shows what your client sent, which is also what the floating numbers show. Logs are in `%APPDATA%\DB DPS Launcher` (`launcher.log`, `dps-overlay.log`).

## Export format

`format: "dbb-dps"`, `version: 2`, laid out the way GOOD (the format Genshin Optimizer imports) lays out an inventory: a header, then flat lists of objects that name things by the game's own keys.

- `character`: `key`, `name`, `class`, `spellScan`.
- `fight`: `startedAt`, `stoppedAt`, `durationMs`, `duration`, `levels`, `damage`, `dps`, `casts`, `hits`, `crits`, `critRate`, `critDamage`, `dotDamage`, `dotTicks`, `summonDamage`, `outsideTimer`.
- `distribution`: `byStat` (attack, expertise, unknown), `byKind` (direct, dot), `crits`, each with `damage` and `share`.
- `spells[]`: `key` (the ability, e.g. `PoisonStrike`, or the power's base name for basic attacks and procs, e.g. `RapierMelee`), `name`, `rank`, `slotKey`, `equipped`, `casts`, `hits`, `crits`, `critRate`, `damage`, `share`, `dps`, `directDamage`, `dotDamage`, `dotTicks`, `averageHit`, `biggestHit`, `damageByStat`, `scaling`, `powerIds`.
- `rotation.text`: the Rotation line, e.g. `"MA2 s2 s3 RA1 s4 s1 MA2"`; `rotation.steps[]`: the casts in order as DPS Calculator combo steps (ability keys, one `"basic"` per basic attack); `rotation.casts[]`: each part of the line with `index`, `atMs`, `at`, `endMs`, `key`, `name`, `kind` (`spell`, `melee`, `ranged`, `other`), `label`, `slot`, `slotKey`, `casts`, `rank`, `powerId`, `damage`, `directDamage`, `dotDamage`, `dotTicks`, `hits`, `crits`.
- `targets[]`, `damagePerSecond[]` (one entry per second), `hits[]` (`atMs`, `powerId`, `damage`, `crit`, `kind`, `target`, `summon`), `notes`.

The CSV has the spell table, the fight totals and the rotation, one cast per row.

## Releasing an update

Every push builds the installer and runs the checks; nothing is released until you ask for it:

- **From GitHub**: *Actions* → *Build* → *Run workflow* on `main`, pick `patch` (1.6.0 → 1.6.1), `minor` or `major`, and optionally write what changed (the launcher shows it on the update card). The workflow bumps the version, tags it, builds, starts the built launcher once to check that Flash and the meter load, and publishes the release.
- **From a clone**: `npm version patch` and `git push --follow-tags`. A pushed tag `vX.Y.Z` releases that version.

A release holds `DB-DPS-Launcher-Setup-x.y.z.exe`, its `.blockmap` and `latest.yml`. The launcher reads `latest.yml` to find the update, and the `.blockmap` lets it download only the parts of the installer that changed. The workflow publishes the release only once all three are uploaded. Installed launchers see it within the hour, or the next time they start.

## Building it yourself

Windows, Node 18 or newer:

```
npm ci
npm run flash        # puts Flash in vendor\flash\win32 (needs innoextract), or: node tools/fetch-flash.js --from <pepflashplayer64.dll>
npm start            # runs the launcher from source (no updates)
npm run dist         # builds dist\DB-DPS-Launcher-Setup-x.y.z.exe
```

`npm test` runs the checks: packets, the relays and the web proxy over real sockets, the meter's arithmetic, the export formats, finding Flash, the update states and settings. They run under plain Node 12 (the Node inside Electron 11) and later. `node test/overlay-preview.js <out-dir> [backdrop.png]` renders the meter's windows and the launcher's corner menu with Playwright.

Why these versions: Electron 11 (Chromium 87) is the last Electron that can run the Pepper Flash plugin, and electron-updater 4.3.9 is the last version of it that runs on Electron 11's Node 12.

## Credits

- Flash Player 32.0.0.363 (64-bit Pepper plugin) is Adobe's. The build takes it from [FlashBrowser](https://github.com/radubirsan/FlashBrowser)'s public installer and checks it against a pinned hash (`tools/fetch-flash.js`); it isn't stored in this repository. Builds from 32.0.0.371 on contain Adobe's end-of-life switch and don't run.
- Averia Serif Libre by Dan Sayers, under the SIL Open Font License (`app/fonts/OFL.txt`).
- Built with [Electron](https://www.electronjs.org/) and [electron-builder](https://www.electron.build/).

MIT License, see [LICENSE](LICENSE).
