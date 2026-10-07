'use strict';

/**
 * Renders the meter's windows and the launcher's corner menu on a stand-in for the game page in
 * headless Chromium, with a simulated fight fed through the real meter, and saves screenshots.
 * Development aid; needs Playwright.
 *
 *   node test/overlay-preview.js <out-dir> [backdrop.png] [fonts-dir (default app/fonts)]
 */

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const { DpsMeter } = require('../src/dps/meter');
const { PowerTable } = require('../src/dps/powers');

const outDir = process.argv[2] || 'overlay-preview';
const backdrop = process.argv[3] || '';
const fontsDir = process.argv[4] || path.join(__dirname, '..', 'app', 'fonts');
if (require.main === module) fs.mkdirSync(outDir, { recursive: true });

const table = new PowerTable(JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'src', 'dps', 'powers-snapshot.json'), 'utf8')));

function powerId(group, rank) {
    for (const p of table.byId.values()) if (p.group === group && p.rank === rank) return p.id;
    throw new Error('no power ' + group + rank);
}

const HOTBAR = [
    ['1', 'PoisonStrike'],
    ['2', 'SeverStrike'],
    ['3', 'SteelCyclone'],
    ['4', 'VitalStrike'],
    ['E', 'Assassinate'],
    ['Q', 'SeekingBlades']
];

function scan() {
    return {
        abilities: HOTBAR.map(([, g]) => {
            const p = table.get(powerId(g, 10));
            return { key: g, rank: 10, name: p.label, scalingText: p.scaling.text || '' };
        }),
        hotbar: HOTBAR.map(([k, g]) => ({ key: g, slotKey: k, name: table.get(powerId(g, 10)).label, rank: 10 }))
    };
}

function simulate(seconds, withScan) {
    let now = 0;
    const m = new DpsMeter({ powers: table, now: () => now });
    if (withScan) m.setSpellScan(scan());
    m.start();
    let seed = 7;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    const melee = 969; // RapierMelee
    for (let t = 0; t < seconds * 10; t++) {
        now = t * 100;
        if (t % 6 === 0 && !(t % 45 > 30)) {
            m.recordCast({ powerId: melee, combo: { isMelee: true, id: 1 + ((t / 6) % 3) } });
            m.recordDamage({ kind: 'hit', powerId: melee, damage: 9000 + rnd() * 4000, crit: rnd() < 0.2, targetName: 'GoblinBrute' });
        }
        if (t % 45 === 3) {
            const id = powerId('PoisonStrike', 10);
            m.recordCast({ powerId: id });
            m.recordDamage({ kind: 'hit', powerId: id, damage: 26000 + rnd() * 8000, crit: rnd() < 0.25, targetName: 'GoblinBrute' });
            m.recordDamage({ kind: 'hit', powerId: id, damage: 26000 + rnd() * 8000, crit: rnd() < 0.25, targetName: 'GoblinBrute' });
        }
        if (t % 10 === 5) m.recordDamage({ kind: 'dot', powerId: powerId('PoisonStrike', 10), damage: 11800, targetName: 'GoblinBrute' });
        if (t % 70 === 20) {
            const id = powerId('SeverStrike', 10);
            m.recordCast({ powerId: id });
            for (let k = 0; k < 4; k++) m.recordDamage({ kind: 'hit', powerId: id, damage: 21000 + rnd() * 6000, crit: rnd() < 0.2, targetName: 'GoblinBrute' });
        }
        if (t % 120 === 40) {
            const id = powerId('SteelCyclone', 10);
            m.recordCast({ powerId: id });
            for (let k = 0; k < 4; k++) m.recordDamage({ kind: 'hit', powerId: id, damage: 15000 + rnd() * 5000, crit: rnd() < 0.2, targetName: 'GoblinBrute' });
        }
        if (t % 10 === 8 && t > 50) m.recordDamage({ kind: 'dot', powerId: powerId('SteelCyclone', 10), damage: 6400, targetName: 'GoblinBrute' });
        if (t % 300 === 120) {
            const id = powerId('Assassinate', 10);
            m.recordCast({ powerId: id });
            for (let k = 0; k < 6; k++) m.recordDamage({ kind: 'hit', powerId: id, damage: 30000 + rnd() * 9000, crit: rnd() < 0.3, targetName: 'GoblinBrute' });
        }
        if (t % 97 === 11) m.recordDamage({ kind: 'hit', powerId: 1 + 0, damage: 4000, targetName: 'GoblinBrute' });
    }
    now = seconds * 1000;
    return m;
}

function view(m, extra) {
    return Object.assign(
        {
            version: 'preview',
            meter: m.snapshot(),
            character: 'hgruhgkgn',
            className: 'Rogue',
            level: 'CraftTown',
            link: { state: 'live', text: 'Reading hits for hgruhgkgn' },
            scan: { file: 'DB spells hgruhgkgn.json', scannedAt: '2026-10-06T15:02:00Z', character: 'hgruhgkgn', spells: 12, hotbar: 6 },
            powers: { source: 'bundled', count: table.size },
            settings: { autoStart: false, hidden: false, layout: { rects: {} } },
            lastExport: ''
        },
        extra || {}
    );
}

/** The launcher's corner-menu state, as app/main.js sends it. */
function launcherState(update) {
    return {
        version: '1.6.0',
        update: Object.assign({ state: 'current', current: '1.6.0', version: '', notes: '', percent: 0, error: '', offReason: '', checkedAt: Date.now() - 4 * 60000, manual: false }, update || {}),
        page: 'game',
        gameUrl: 'http://dungeonblitzr.theminesa.studio/',
        flash: { version: '32.0.0.363', source: 'bundled', path: 'C:\\...\\pepflashplayer64.dll' },
        flashRejected: [],
        fullScreen: false
    };
}

function harness(views, fonts, launcher) {
    const preload = fs.readFileSync(path.join(__dirname, '..', 'src', 'dps', 'preload.js'), 'utf8');
    const uiPreload = fs.readFileSync(path.join(__dirname, '..', 'app', 'ui', 'preload.js'), 'utf8');
    return `
      (function () {
        const views = ${JSON.stringify(views)};
        const fonts = ${JSON.stringify(fonts)};
        let launcher = ${JSON.stringify(launcher || null)};
        let current = views[0];
        const listeners = {};
        window.__dbdpsSet = (v) => { current = v; (listeners['dbdps:snapshot'] || []).forEach((cb) => cb({}, v)); };
        window.__launcherSet = (s) => { launcher = s; (listeners['launcher:state'] || []).forEach((cb) => cb({}, s)); };
        const ipcRenderer = {
          on: (ch, cb) => { (listeners[ch] = listeners[ch] || []).push(cb); },
          invoke: (ch, cmd, arg) => {
            window.__lastCmd = cmd;
            if (ch === 'launcher:hello') return Promise.resolve(launcher);
            if (ch === 'launcher:cmd') return Promise.resolve({ ok: true, state: launcher });
            return Promise.resolve({ ok: true, view: current });
          }
        };
        const shim = (m) => {
          if (m === 'electron') return { ipcRenderer, contextBridge: { exposeInMainWorld() {} } };
          if (m === 'path') return { join: (...a) => a.join('/') };
          if (m === 'fs') return { readFileSync: (p) => { const b = fonts[p.split('/').pop()]; if (!b) throw new Error('no font'); return Uint8Array.from(atob(b), (c) => c.charCodeAt(0)); } };
          throw new Error('module ' + m);
        };
        (function (require, __dirname) { ${preload} })(shim, '/app/src/dps');
        if (launcher) (function (require, __dirname) { ${uiPreload} })(shim, '/app/app/ui');
      })();`;
}

const PAGE = (bg) => `<!DOCTYPE html><html><head><style>
  html,body{margin:0;padding:0;width:100%;height:100%;background:#484955;overflow:hidden;display:flex;align-items:center;justify-content:center}
  #game-container{width:100vw;height:100vh;background:#484955 ${bg ? `url(data:image/png;base64,${bg}) center/auto 100% no-repeat` : ''}}
  </style></head><body><div id="game-container"><object id="DungeonBlitz" type="application/x-shockwave-flash" width="100%" height="100%"></object></div></body></html>`;

module.exports = { harness, view, launcherState, PAGE };

if (require.main === module) (async () => {
    const fonts = {};
    if (fontsDir) {
        for (const f of ['averia-serif-libre-400.woff2', 'averia-serif-libre-700.woff2']) {
            const p = path.join(fontsDir, f);
            if (fs.existsSync(p)) fonts[f] = fs.readFileSync(p).toString('base64');
        }
    }
    const bg = backdrop && fs.existsSync(backdrop) ? fs.readFileSync(backdrop).toString('base64') : '';
    const fight = simulate(83, true);
    const views = [view(fight)];
    const browser = await chromium.launch();
    const shots = [
        { name: '2k-150pct', w: 1707, h: 889, dpr: 1.5, v: view(fight) },
        { name: '2k-150pct-early-noscan', w: 1707, h: 889, dpr: 1.5, v: view(simulate(7, false), { scan: null }) },
        { name: '2k-150pct-idle-noscan', w: 1707, h: 889, dpr: 1.5, v: view(new DpsMeter({ powers: table }), { scan: null, link: { state: 'waiting', text: 'Waiting for the game to connect' } }) },
        { name: '1080p-100pct', w: 1920, h: 1009, dpr: 1, v: view(fight) },
        { name: '1200x800-compact', w: 1184, h: 761, dpr: 1, v: view(fight) },
        { name: '2k-150pct-hidden', w: 1707, h: 889, dpr: 1.5, v: view(fight, { settings: { autoStart: false, hidden: true, layout: { rects: {} } } }) },
        { name: '2k-150pct-moved', w: 1707, h: 889, dpr: 1.5, v: view(fight, { settings: { autoStart: false, hidden: false, layout: { rects: { spells: { x: 1180, y: 120, w: 260, h: 420 }, rotation: { x: 330, y: 560, w: 520, h: 0 } } } } }) },
        { name: 'launcher-chip', w: 1707, h: 889, dpr: 1.5, v: view(fight), launcher: launcherState() },
        { name: 'launcher-ready', w: 1707, h: 889, dpr: 1.5, v: view(fight), launcher: launcherState({ state: 'ready', version: '1.6.1', percent: 100, notes: '- The Rotation line wraps at the window edge\n- Faster start-up' }) },
        { name: 'launcher-menu', w: 1707, h: 889, dpr: 1.5, v: view(fight), launcher: launcherState(), openMenu: true },
        { name: 'launcher-downloading-menu-1200', w: 1184, h: 761, dpr: 1, v: view(fight), launcher: launcherState({ state: 'downloading', version: '1.6.1', percent: 38 }), openMenu: true }
    ];
    for (const s of shots) {
        const ctx = await browser.newContext({ viewport: { width: s.w, height: s.h }, deviceScaleFactor: s.dpr });
        const page = await ctx.newPage();
        await page.addInitScript(harness([s.v], fonts, s.launcher));
        // An http page, like the real game page (the overlay only acts on http(s)).
        await page.route('http://dbdps.test/**', (route) => route.fulfill({ status: 200, contentType: 'text/html', body: PAGE(bg) }));
        page.on('pageerror', (e) => console.log('page error:', e.message));
        await page.goto('http://dbdps.test/');
        await page.waitForTimeout(300);
        await page.evaluate((v) => window.__dbdpsSet(v), s.v);
        if (s.name === '2k-150pct') {
            // Open one spell's details, the way a click would.
            await page.mouse.click(1707 - 100, 120);
            await page.waitForTimeout(100);
        }
        if (s.name === '2k-150pct-moved') {
            // Drag the Damage Meter by its title a little to the right and down.
            await page.mouse.move(60, 22);
            await page.mouse.down();
            await page.mouse.move(120, 60, { steps: 5 });
            await page.mouse.up();
            await page.waitForTimeout(150);
            console.log('  last command:', await page.evaluate(() => window.__lastCmd));
        }
        if (s.openMenu) {
            // The chip sits in the bottom-right corner; its shadow root is closed, so click by position.
            await page.mouse.click(s.w - 40, s.h - 22);
            await page.waitForTimeout(150);
        }
        await page.waitForTimeout(200);
        const file = path.join(outDir, s.name + '.png');
        await page.screenshot({ path: file });
        const errors = await page.evaluate(() => ({
            panels: Array.from(document.querySelectorAll('#dbdps .panel')).map((p) => {
                const r = p.getBoundingClientRect();
                return [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height), p.hidden, p.scrollHeight > p.clientHeight + 2];
            }),
            font: document.fonts.check('12px "DBDPS Averia"')
        }));
        console.log(s.name, JSON.stringify(errors));
        await ctx.close();
    }
    await browser.close();
})();
