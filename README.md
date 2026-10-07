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

- **Damage Meter** (top left): a timer you start and stop (F6), reset (F7) and hide (F8); DPS, total damage, casts, hits and crit rate; **DPS over time**; **Scaling**: how much of your damage scales with Attack and how much with Expertise, how much came over time (DoTs) and from crits. Every direct hit counts for Attack, because the game client works out each hit as the power's damage multiplier times your Attack, whatever its element (Bitter Blade, Frozen Ward and Frigid Comet hit with Attack); every damage-over-time tick counts for Expertise, because the game puts your Expertise into each DoT when it lands (Chilblains from Frigid Comet counts for Frigid Comet, as Expertise).
- **Rotation** (under the Damage Meter): your casts in order as one line, like `MA2 s2 s3 RA1 s4 s1 MA2`. `s3` is the spell in hotbar slot 3 (s1 to s6 are keys 1, 2, 3, 4, E, Q); `MA` (melee attack) and `RA` (ranged attack) are basic attacks in a row (until something else is cast or the clock stops), with the number of hits they landed. Hover any part for the spell, the time and its damage.
- **Spells** (top right): your hotbar spells by slot, each with its rank, share of your damage and casts; click one for its DPS, hits, crit rate, average and biggest hit, DoT damage and Stats line. Each spell gets all the damage it causes by the game's rules: Shadow Legion its clones' attacks; Charon's Blades the critical hits of its form (a hotbar spell cast in that form, like Crimson Butterfly, keeps its own); Hailstone Embrace its Frost Armor ice and enchanted attacks; Black Miasma its Shadow Tendril cloud. Your basic attacks (*Melee*, Bone Daggers, ...), rune procs and pets are under *Other damage*, which lists only what did damage. The mount (Summon Mount, Dismount) and the procs the game fires by itself (Devour's heal) are left out.
- **Export…** to a JSON file (everything: spells, the rotation, every hit) or a CSV table for spreadsheets, and **Copy summary** for chat.

**Dungeon mode** (the switch under *Start on first hit*) times a dungeon run: your first hit starts the timer; dying, or 3 seconds without damage from you (hits, damage over time and your summons all count), pauses it, with the clock stopped at your last hit so the wait isn't counted; your next hit carries on. The run ends when the dungeon is done: the game's Level Complete (in a boss dungeon, when its final boss dies) or 100% completion. A boss that isn't the last (the first of the Bandit Twins, say) pauses the clock like a lull. The casts that led to the hit that starts or restarts the clock are part of the run: the cast whose hit it was, anything cast after it and anything cast in the 3 seconds before it go into the rotation at the moment the clock starts; casts made after your last hit, before the lull is noticed, are timed at the moment it paused. The line under the switch shows the dungeon, how much of it is cleared, why the clock paused and how the run ended. After a run, your first hit in the next dungeon starts a new one (export the last one before that if you want to keep it). Stop (F6) ends a run by hand and Resume carries it on.

Drag any window by its title to move it, and resize it from its bottom-right corner; it stays where you put it. *Reset layout* (in the Damage Meter's status lines) puts them all back. Hits and casts only count while the timer runs; turn on *Start on first hit* to start it with your first hit (the cast that landed it counts too). F8 (or ×) hides the windows and leaves a small *Damage Meter* tab in the top-left corner.

If you used the meter as a mod of the official launcher, its window layout and settings are copied over the first time this launcher starts.

### Spells from DB Inventory Scanner

The meter names every hit from the game's own data (it loads the server's `Game.swz`). Which spells are on your hotbar comes from [DB Inventory Scanner](https://github.com/killssingkurisu/db-inventory-scanner): open the Tome of Power, press **Scan spells**, and the meter picks the newest spell scan for your character up by itself. Without a scan it lists the spells you've used.

## How it reads your damage

The game client works out each hit's damage and sends it to the server: packet 0x0A for a hit and 0x79 for a damage-over-time tick; casts are packet 0x09. The launcher reads them on the way out:

1. The game website's plain-HTTP traffic goes through a small local proxy in the launcher, which passes every request on to the real site unchanged, except `DungeonBlitz.swf`: the copy handed to Flash logs in through `127.0.0.1` (two values changed: the login host and port). Flash's own sockets ignore Chromium's host rules, which is why the client itself is pointed at the launcher.
2. A relay on `127.0.0.1` forwards the client's bytes to the real login server as they arrive and reads a copy. "Enter world" (0x21), which names the server for the next level, is pointed at another relay, so every connection after login goes through the meter too. Flash's socket-policy requests are answered locally.
3. Dungeon mode reads three more things the client sends or gets: entity states (0x07 and 0x08; state 3 is dead) for your own character and for monsters, which the game's EntTypes rank as Boss or not; the dungeon's completion percent (0xb7, which the client computes from its cleared rooms); and Level Complete (0x3f from your client, 0x87 from the server).
4. Training dummies: the game client works out DoT ticks on the house dummies but never sends them. The SWF the launcher serves sends them too, and the relay counts those ticks and keeps them from the server, so the server sees what an unmodified client sends.

Nothing on the server changes. Your hits are the ones whose attacker is your character or one of its summons. The server can add to your damage after it arrives (the Soulthief passive, admin damage scaling), so the meter shows what your client sent, which is also what the floating numbers show. Logs are in `%APPDATA%\DB DPS Launcher` (`launcher.log`, `dps-overlay.log`).

## Export format

`format: "dbb-dps"`, `version: 2`, laid out the way GOOD (the format Genshin Optimizer imports) lays out an inventory: a header, then flat lists of objects that name things by the game's own keys.

- `character`: `key`, `name`, `class`, `spellScan`.
- `fight`: `startedAt`, `stoppedAt`, `durationMs`, `duration`, `levels`, `damage`, `dps`, `casts`, `hits`, `crits`, `critRate`, `critDamage`, `dotDamage`, `dotTicks`, `summonDamage`, `outsideTimer`, and with Dungeon mode `dungeon`: `level`, `name`, `completion`, `state`, `endedBy` (`boss`, `cleared`, `complete`, `left`, `manual`), `deaths`, `idlePauses`, `bosses` (each with `name`, `atMs`, `at`).
- `distribution`: `byStat` (attack, expertise, unknown), `byKind` (direct, dot), `crits`, each with `damage` and `share`.
- `spells[]`: `key` (the ability, e.g. `PoisonStrike`, or the power's base name for basic attacks and procs, e.g. `RapierMelee`), `name`, `rank`, `slotKey`, `equipped`, `casts`, `hits`, `crits`, `critRate`, `damage`, `share`, `dps`, `directDamage`, `dotDamage`, `dotTicks`, `averageHit`, `biggestHit`, `damageByStat`, `scaling`, `powerIds`.
- `rotation.text`: the Rotation line, e.g. `"MA2 s2 s3 RA1 s4 s1 MA2"`; `rotation.steps[]`: the casts in order as DPS Calculator combo steps (ability keys, one `"basic"` per basic attack); `rotation.casts[]`: each part of the line with `index`, `atMs`, `at`, `endMs`, `key`, `name`, `kind` (`spell`, `melee`, `ranged`, `other`), `label`, `slot`, `slotKey`, `casts`, `castTimesMs` (when each of those casts was made, so every basic attack in a run has its own time), `rank`, `powerId`, `damage`, `directDamage`, `dotDamage`, `dotTicks`, `hits`, `crits`.
- `targets[]`, `damagePerSecond[]` (one entry per second), `hits[]` (`atMs`, `powerId`, `damage`, `crit`, `kind`, `target`, `summon`, `spell`), `notes`.

Times (`atMs`, `endMs`, `castTimesMs`, `hits[].atMs`) are milliseconds on the meter's clock, from your first hit; with Dungeon mode the pauses aren't in it, so they're fighting time. `fight.startedAt` and `stoppedAt` are the time of day.

The CSV has the spell table, the fight totals and the rotation, one part of the line per row, with the time of each of its casts.

## Releasing an update

Every push builds the installer and runs the checks; nothing is released until you ask for it:

- **From GitHub**: *Actions* → *Build* → *Run workflow* on `main`, pick `patch` (1.6.0 → 1.6.1), `minor` or `major` (or `current` to release the version `package.json` already has), and optionally write what changed (the launcher shows it on the update card). The workflow bumps the version, tags it, builds, starts the built launcher once to check that Flash and the meter load, and publishes the release.
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
