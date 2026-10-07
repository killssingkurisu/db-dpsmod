'use strict';

/**
 * The DPS overlay on the game page: three windows in the grey gutters beside the game's 3:2
 * picture (the page gives the whole window to Flash and the game clips itself to a centred 3:2
 * box, see the page's #game-container comment).
 *
 *   Damage Meter  left gutter, top            Spells  right gutter, top
 *   Rotation      left gutter, under the meter
 *
 * Each window can be dragged by its title and resized from its bottom-right corner. Moved or
 * resized windows keep their place (dps-overlay.json); "reset layout" puts them all back. When the window is too narrow for gutters they start stacked in
 * the top corners instead.
 *
 * Runs as a session preload, so it loads in every page of the launcher; it only acts on an
 * http(s) page that holds the game's object.
 */

const { ipcRenderer } = require('electron');
const fs = require('fs');
const path = require('path');

const SIDE_MIN = 150; // narrowest gutter that still takes the windows, in CSS px
const SIDE_MAX = 300;
const FLOAT_W = 230; // window width when there are no gutters
const SPELLS_NARROW = 150; // below this the Spells rows stack their numbers
const GAP = 6;
const PANELS = ['fight', 'rotation', 'spells'];

const CSS = `
#dbdps {
  --ink: rgba(28, 26, 13, 0.95);
  --ink-solid: #1c1a0d;
  --well: #2a2612;
  --parch: #eee2bc;
  --parch-dim: #b5a983;
  --brass: #b8973f;
  --brass-dim: rgba(184, 151, 63, 0.38);
  --cyan: #00ccff;
  --citrine: #e3b341;
  --sapphire: #4f8fe6;
  --unclassed: #6f6a58;
  --alarm: #d6453d;
  position: fixed; top: 0; left: 0; right: 0; bottom: 0; pointer-events: none; z-index: 2147483000;
  font-family: "DBDPS Averia", Georgia, "Times New Roman", serif;
  font-size: var(--fs, 12px); line-height: 1.35; color: var(--parch);
  -webkit-font-smoothing: antialiased; user-select: none;
}
#dbdps * { box-sizing: border-box; margin: 0; padding: 0; }
#dbdps i { font-style: normal; }
#dbdps[hidden], #dbdps [hidden] { display: none !important; }
#dbdps .panel {
  position: absolute; pointer-events: auto; display: flex; flex-direction: column; gap: 0.7em;
  background: var(--ink); border: 1px solid var(--brass); border-radius: 5px;
  box-shadow: inset 0 0 0 3px var(--ink-solid), inset 0 0 0 4px var(--brass-dim), 0 6px 18px rgba(0,0,0,0.35);
  padding: 0.85em 0.85em 0.75em; overflow: hidden; min-width: 120px; min-height: 52px;
}
#dbdps .panel { resize: both; }
#dbdps .panel.fight { overflow-y: auto; overflow-x: hidden; scrollbar-width: thin; }
#dbdps .panel.dragging { opacity: 0.92; box-shadow: inset 0 0 0 3px var(--ink-solid), inset 0 0 0 4px var(--brass-dim), 0 10px 26px rgba(0,0,0,0.5); }
#dbdps .head { display: flex; align-items: center; gap: 0.45em; min-height: 1.5em; }
#dbdps .head { cursor: move; }
#dbdps .head h2 { font-size: 1.08em; font-weight: 700; flex: 1; letter-spacing: 0.01em; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
#dbdps .head .sub { font-size: 0.82em; color: var(--parch-dim); font-weight: 400; white-space: nowrap; }
#dbdps .dot { width: 0.6em; height: 0.6em; border-radius: 50%; border: 1px solid var(--brass); flex: none; }
#dbdps .dot.running { background: var(--alarm); border-color: var(--alarm); animation: dbdps-pulse 1.2s ease-in-out infinite; }
#dbdps .dot.stopped { background: var(--brass); }
@keyframes dbdps-pulse { 50% { opacity: 0.35; } }
@media (prefers-reduced-motion: reduce) { #dbdps .dot.running { animation: none; } }
#dbdps .iconbtn { all: unset; cursor: pointer; color: var(--parch-dim); width: 1.4em; height: 1.4em; display: grid; place-items: center; border-radius: 3px; font-size: 1.05em; flex: none; }
#dbdps .iconbtn:hover { color: var(--parch); background: var(--well); }
#dbdps .clock { font-size: 2.05em; font-weight: 700; line-height: 1; }
#dbdps .d { display: inline-block; width: 0.6em; text-align: center; }
#dbdps .sep { display: inline-block; width: 0.28em; text-align: center; }
#dbdps .controls { display: flex; gap: 0.45em; }
#dbdps .btn {
  all: unset; cursor: pointer; flex: 1; text-align: center; padding: 0.38em 0.4em; border-radius: 3px;
  border: 1px solid var(--brass); color: var(--parch); font-weight: 700; font-size: 0.95em; white-space: nowrap;
}
#dbdps .btn:hover { background: var(--well); }
#dbdps .btn.primary { background: linear-gradient(#ecc85b, #c99a2e); color: #20180a; border-color: #6b5418; }
#dbdps .btn.primary:hover { background: linear-gradient(#f5d670, #d6a737); }
#dbdps .btn.primary.stop { background: linear-gradient(#e0614f, #ae3326); color: #fff3e8; border-color: #5e1810; }
#dbdps .btn:focus-visible, #dbdps .iconbtn:focus-visible, #dbdps .toggle:focus-visible { outline: 2px solid var(--cyan); outline-offset: 1px; }
#dbdps .dps { display: flex; flex-direction: column; }
#dbdps .dps .num { font-size: 2.35em; font-weight: 700; color: var(--cyan); line-height: 1.05; text-shadow: 0 1px 0 #000; }
#dbdps .dps .unit { color: var(--parch-dim); font-size: 0.88em; }
#dbdps .facts { display: grid; grid-template-columns: 1fr auto; gap: 0.15em 0.6em; font-size: 0.95em; }
#dbdps .facts dt { color: var(--parch-dim); }
#dbdps .facts dd { text-align: right; font-weight: 700; }
#dbdps .graph { display: flex; flex-direction: column; gap: 0.2em; }
#dbdps .graph .glabel { display: flex; justify-content: space-between; align-items: baseline; font-size: 0.86em; color: var(--parch-dim); }
#dbdps .graph .glabel b { color: var(--parch); font-weight: 700; }
#dbdps .graph svg { width: 100%; height: 4.2em; display: block; background: rgba(42, 38, 18, 0.55); border-radius: 2px; }
#dbdps .graph .gaxis { display: flex; justify-content: space-between; font-size: 0.76em; color: var(--parch-dim); }
#dbdps .graph .gkey { display: flex; gap: 0.9em; font-size: 0.78em; color: var(--parch-dim); }
#dbdps .graph .gkey span { display: inline-flex; align-items: center; gap: 0.35em; }
#dbdps .graph .gkey .line { width: 1em; height: 0; border-top: 2px solid var(--cyan); }
#dbdps .graph .gkey .area { width: 0.8em; height: 0.6em; background: rgba(0, 204, 255, 0.28); }
#dbdps .graph .gempty { font-size: 0.82em; color: var(--parch-dim); padding: 0.4em 0; }
#dbdps h3 { font-size: 0.95em; font-weight: 700; color: var(--parch); border-top: 1px solid var(--brass-dim); padding-top: 0.55em; }
#dbdps .split { display: flex; height: 0.75em; border-radius: 2px; overflow: hidden; background: var(--well); }
#dbdps .split i, #dbdps .bar i { display: block; height: 100%; }
#dbdps .atk { background: var(--citrine); }
#dbdps .exp { background: var(--sapphire); }
#dbdps .unk { background: var(--unclassed); }
#dbdps .legend { display: flex; flex-wrap: wrap; gap: 0.15em 0.8em; font-size: 0.9em; }
#dbdps .legend span { display: inline-flex; align-items: center; gap: 0.35em; }
#dbdps .legend b { width: 0.65em; height: 0.65em; border-radius: 1px; display: inline-block; }
#dbdps .note { font-size: 0.88em; color: var(--parch-dim); }
#dbdps .row { display: flex; gap: 0.45em; }
#dbdps .row .btn { font-weight: 400; }
#dbdps .toggle { all: unset; cursor: pointer; display: inline-flex; align-items: center; gap: 0.45em; font-size: 0.92em; color: var(--parch); }
#dbdps .toggle b { width: 1.9em; height: 1em; border-radius: 0.5em; background: var(--well); border: 1px solid var(--brass-dim); position: relative; flex: none; }
#dbdps .toggle b::after { content: ""; position: absolute; top: 0.1em; left: 0.12em; width: 0.7em; height: 0.7em; border-radius: 50%; background: var(--parch-dim); transition: left 0.12s; }
#dbdps .toggle[aria-pressed="true"] b { background: #0b4357; border-color: var(--cyan); }
#dbdps .toggle[aria-pressed="true"] b::after { left: 1.05em; background: var(--cyan); }
#dbdps .status { font-size: 0.82em; color: var(--parch-dim); display: flex; flex-direction: column; gap: 0.3em; border-top: 1px solid var(--brass-dim); padding-top: 0.55em; }
#dbdps .status .link { display: flex; gap: 0.4em; align-items: baseline; }
#dbdps .status .link::before { content: ""; width: 0.5em; height: 0.5em; border-radius: 50%; background: var(--brass); flex: none; transform: translateY(-0.05em); }
#dbdps .status .link.live::before { background: var(--cyan); }
#dbdps .status .link.error { color: #f0a59c; }
#dbdps .status .link.error::before { background: var(--alarm); }
#dbdps .status a { color: var(--parch); cursor: pointer; text-decoration: underline; text-decoration-color: var(--brass-dim); }
#dbdps .rot { min-height: 0; flex: 1; overflow-y: auto; line-height: 1.6; word-spacing: 0.12em; scrollbar-width: thin; }
#dbdps .rot::-webkit-scrollbar, #dbdps .spells::-webkit-scrollbar, #dbdps .panel.fight::-webkit-scrollbar { width: 6px; }
#dbdps .rot::-webkit-scrollbar-thumb, #dbdps .spells::-webkit-scrollbar-thumb, #dbdps .panel.fight::-webkit-scrollbar-thumb { background: var(--brass-dim); border-radius: 3px; }
#dbdps .rot .t { font-weight: 700; color: var(--parch); white-space: nowrap; }
#dbdps .rot .t.basic { font-weight: 400; color: var(--parch-dim); }
#dbdps .rot .t.crit { color: var(--cyan); }
#dbdps .rot .t.last { text-decoration: underline; text-decoration-color: var(--brass); text-underline-offset: 0.2em; }
#dbdps .rot .empty { font-size: 0.9em; }
#dbdps .spells { min-height: 0; flex: 1; overflow-y: auto; display: flex; flex-direction: column; gap: 0.2em; margin-right: -0.4em; padding-right: 0.4em; }
#dbdps .group { font-size: 0.85em; color: var(--parch-dim); padding: 0.5em 0 0.15em; }
#dbdps .spell { display: flex; flex-direction: column; gap: 0.2em; padding: 0.35em 0.4em; border-radius: 3px; cursor: pointer; }
#dbdps .spell:hover { background: rgba(42, 38, 18, 0.8); }
#dbdps .spell .l1 { display: flex; align-items: baseline; gap: 0.4em; min-width: 0; }
#dbdps kbd { font: inherit; font-size: 0.8em; font-weight: 700; min-width: 1.45em; text-align: center; padding: 0 0.25em; border: 1px solid var(--brass); border-radius: 3px; background: var(--well); line-height: 1.35; flex: none; }
#dbdps .spell .name { flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; font-weight: 700; }
#dbdps .spell.idle .name { font-weight: 400; color: var(--parch-dim); }
#dbdps .spell .rank { color: var(--cyan); font-size: 0.85em; flex: none; }
#dbdps .bar { display: flex; height: 0.45em; border-radius: 2px; overflow: hidden; background: var(--well); }
#dbdps .bar .fill { display: flex; height: 100%; }
#dbdps .spell .l2 { display: flex; gap: 0.5em; font-size: 0.88em; color: var(--parch-dim); }
#dbdps .spell .l2 .dmg { color: var(--parch); font-weight: 700; }
#dbdps .spell .l2 .casts { margin-left: auto; }
#dbdps .spell .more { display: grid; grid-template-columns: 1fr auto; gap: 0.1em 0.6em; font-size: 0.86em; padding-top: 0.25em; }
#dbdps .spell .more dt { color: var(--parch-dim); }
#dbdps .spell .more dd { text-align: right; }
#dbdps .spell .more .desc { grid-column: 1 / -1; color: var(--parch-dim); font-style: italic; padding-top: 0.2em; text-align: left; }
#dbdps .spellpanel.narrow { padding-left: 0.6em; padding-right: 0.6em; }
#dbdps .spellpanel.narrow .spell { padding: 0.3em 0.25em; }
#dbdps .spellpanel.narrow .spell .name { white-space: normal; overflow-wrap: anywhere; line-height: 1.15; }
#dbdps .spellpanel.narrow .spell .rank { display: none; }
#dbdps .spellpanel.narrow .spell .l2 { flex-wrap: wrap; gap: 0 0.45em; }
#dbdps .spellpanel.narrow .spell .l2 .casts { margin-left: 0; }
#dbdps .spellpanel.narrow .spell .more { font-size: 0.8em; gap: 0.05em 0.4em; }
#dbdps .empty { color: var(--parch-dim); font-size: 0.92em; padding: 0.3em 0.1em; }
#dbdps .reveal {
  all: unset; pointer-events: auto; position: absolute; left: 8px; top: 8px; box-sizing: border-box;
  padding: 0.4em 0.75em; cursor: pointer; font-weight: 700; font-size: 0.9em; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  background: var(--ink); color: var(--parch-dim); border: 1px solid var(--brass); border-radius: 4px;
}
#dbdps .reveal:hover { color: var(--parch); }
`;

function onGamePage() {
    if (!/^https?:$/.test(location.protocol)) return false;
    return Boolean(document.getElementById('game-container') || document.querySelector('object[type="application/x-shockwave-flash"], embed'));
}

/** Averia Serif Libre (SIL Open Font License), shipped in app/fonts. */
function loadFonts() {
    const dir = path.join(__dirname, '..', '..', 'app', 'fonts');
    for (const [file, weight] of [['averia-serif-libre-400.woff2', '400'], ['averia-serif-libre-700.woff2', '700']]) {
        try {
            const face = new FontFace('DBDPS Averia', fs.readFileSync(path.join(dir, file)), { weight });
            document.fonts.add(face);
            face.load().catch(() => {});
        } catch (_e) {
            // Georgia stands in.
        }
    }
}

/* ---------- formatting ---------- */

function esc(s) {
    return String(s === undefined || s === null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function int(n) {
    return Math.round(Number(n) || 0).toLocaleString('en-US');
}

function short(n) {
    n = Math.round(Number(n) || 0);
    if (n >= 1e9) return (n / 1e9).toFixed(n >= 1e10 ? 1 : 2) + 'B';
    if (n >= 1e7) return (n / 1e6).toFixed(n >= 1e8 ? 0 : 1) + 'M';
    return n.toLocaleString('en-US');
}

/** At most four characters: 850, 4.3k, 48k, 1.2M, 12M. */
function compact(n) {
    n = Math.round(Number(n) || 0);
    const f = (v, unit) => (v < 10 ? (Math.floor(v * 10) / 10).toFixed(1).replace(/\.0$/, '') : String(Math.floor(v))) + unit;
    if (n < 1000) return String(n);
    if (n < 1e6) return f(n / 1e3, 'k');
    if (n < 1e9) return f(n / 1e6, 'M');
    return f(n / 1e9, 'B');
}

function pct(part, whole) {
    return whole ? Math.round((part / whole) * 100) + '%' : '0%';
}

function clock(ms) {
    const t = Math.max(0, Math.floor(ms / 100));
    const s = Math.floor(t / 10);
    const m = Math.floor(s / 60);
    const h = Math.floor(m / 60);
    const pad = (x) => String(x).padStart(2, '0');
    return (h ? h + ':' + pad(m % 60) : String(m)) + ':' + pad(s % 60) + '.' + (t % 10);
}

function mmss(sec) {
    const s = Math.max(0, Math.round(sec));
    return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
}

/** Digits in fixed cells, so a running number doesn't shuffle sideways. */
function cells(text) {
    return String(text)
        .split('')
        .map((c) => (/\d/.test(c) ? '<i class="d">' + c + '</i>' : '<i class="sep">' + esc(c) + '</i>'))
        .join('');
}

function when(iso) {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }) + ', ' + d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
}

function head(title, id, extra) {
    return (
        '<div class="head" data-drag="' + id + '">' +
        (extra || '') +
        '<h2>' + title + '</h2>' +
        '<span class="sub" data-el="' + id + 'Sub"></span>' +
        (id === 'fight' ? '<button class="iconbtn" data-cmd="hide" title="Hide (F8)">&#215;</button>' : '') +
        '</div>'
    );
}

/* ---------- the overlay ---------- */

class Overlay {
    constructor() {
        this.view = null;
        this.open = new Set(); // spell keys with details shown
        this.rowEls = new Map();
        this.copiedAt = 0;
        this.drag = null;
        this.resizing = null;
        this.rotStick = true; // keep the newest cast in view until the player scrolls up
        this.layoutState = { rects: {} };
    }

    mount() {
        const style = document.createElement('style');
        style.id = 'dbdps-style';
        style.textContent = CSS;
        document.head.appendChild(style);

        const root = document.createElement('div');
        root.id = 'dbdps';
        root.setAttribute('role', 'complementary');
        root.setAttribute('aria-label', 'Damage Meter');
        root.innerHTML = `
          <section class="panel fight" data-panel="fight" aria-label="Damage Meter">
            ${head('Damage Meter', 'fight', '<span class="dot" data-el="dot"></span>')}
            <div class="clock" data-el="clock"></div>
            <div class="controls">
              <button class="btn primary" data-cmd="toggle" data-el="toggle">Start</button>
              <button class="btn" data-cmd="reset">Reset</button>
            </div>
            <div class="dps"><span class="num" data-el="dps"></span><span class="unit">damage per second</span></div>
            <dl class="facts">
              <dt>Total damage</dt><dd data-el="total"></dd>
              <dt>Casts</dt><dd data-el="casts"></dd>
              <dt>Hits</dt><dd data-el="hits"></dd>
              <dt>Crit rate</dt><dd data-el="crit"></dd>
            </dl>
            <div class="graph" title="Damage per second over the whole fight. Shaded: the DPS over the 5 seconds up to each moment. Line: your average so far, which ends at the big number above.">
              <div class="glabel"><span>DPS over time</span><span data-el="gpeak"></span></div>
              <svg data-el="spark" viewBox="0 0 120 36" preserveAspectRatio="none" aria-hidden="true"></svg>
              <div class="gaxis"><span>0:00</span><span data-el="gend"></span></div>
              <div class="gkey"><span><i class="line"></i>average</span><span><i class="area"></i>last 5 s</span></div>
            </div>
            <h3>Scaling</h3>
            <div class="split" data-el="split" title="Share of damage by the stat it scales with"></div>
            <div class="legend" data-el="legend"></div>
            <p class="note" data-el="kinds"></p>
            <p class="note" data-el="ignored" hidden></p>
            <div class="row">
              <button class="btn" data-cmd="export">Export&#8230;</button>
              <button class="btn" data-cmd="copy" data-el="copy">Copy summary</button>
            </div>
            <button class="toggle" data-cmd="autoStart" data-el="auto" aria-pressed="false"><b></b>Start on first hit</button>
            <div class="status" data-el="status"></div>
          </section>
          <section class="panel rotpanel" data-panel="rotation" aria-label="Rotation">
            ${head('Rotation', 'rotation')}
            <div class="rot" data-el="rot"></div>
          </section>
          <section class="panel spellpanel" data-panel="spells" aria-label="Spells">
            ${head('Spells', 'spells')}
            <div class="spells" data-el="spells"></div>
          </section>
          <button class="reveal" data-cmd="show" hidden>Damage Meter</button>`;
        document.body.appendChild(root);
        this.root = root;
        this.el = {};
        for (const n of root.querySelectorAll('[data-el]')) this.el[n.dataset.el] = n;
        this.panels = {
            fight: root.querySelector('.fight'),
            rotation: root.querySelector('.rotpanel'),
            spells: root.querySelector('.spellpanel')
        };
        this.reveal = root.querySelector('.reveal');

        // Clicks act on mousedown and never take focus away from the game, so the keyboard keeps
        // driving the character after pressing a button here. The one exception is a window's
        // resize corner, which needs the browser's own handling.
        root.addEventListener('mousedown', (e) => this.onMouseDown(e), true);
        window.addEventListener('mousemove', (e) => this.onDrag(e));
        window.addEventListener('mouseup', () => this.endDrag());
        window.addEventListener('resize', () => this.layout());
        this.el.rot.addEventListener('scroll', () => {
            const r = this.el.rot;
            this.rotStick = r.scrollTop + r.clientHeight >= r.scrollHeight - 6;
        });
        ipcRenderer.on('dbdps:snapshot', (_e, view) => this.render(view));
        ipcRenderer.invoke('dbdps:cmd', 'hello').then((r) => r && r.view && this.render(r.view)).catch(() => {});
        this.layout();
    }

    focusGame() {
        const game = document.getElementById('DungeonBlitz') || document.querySelector('object, embed');
        if (game && typeof game.focus === 'function') game.focus();
    }

    /* ---------- input ---------- */

    onMouseDown(e) {
        if (e.button !== 0) return;
        const panel = e.target.closest('.panel');
        if (panel && e.target === panel) {
            const r = panel.getBoundingClientRect();
            if (e.clientX > r.right - 18 && e.clientY > r.bottom - 18) {
                this.resizing = panel.dataset.panel; // the browser resizes it; saved on mouseup
                return;
            }
        }
        e.preventDefault();
        const target = e.target.closest('[data-cmd], .spell, a[data-act], [data-drag]');
        if (!target) return;
        if (target.matches('[data-drag]') && !e.target.closest('[data-cmd]')) {
            const id = target.dataset.drag;
            const box = this.panels[id].getBoundingClientRect();
            this.drag = { id, dx: e.clientX - box.left, dy: e.clientY - box.top, x0: e.clientX, y0: e.clientY, moved: false };
            return;
        }
        if (target.matches('a[data-act]')) {
            this.send(target.dataset.act);
            return;
        }
        if (target.matches('.spell')) {
            const key = target.dataset.key;
            if (this.open.has(key)) this.open.delete(key);
            else this.open.add(key);
            if (this.view) this.renderSpells(this.view);
            return;
        }
        const cmd = target.dataset.cmd;
        if (cmd === 'autoStart') {
            this.send('autoStart', !(this.view && this.view.settings.autoStart));
            return;
        }
        if (cmd === 'copy') {
            this.send('copy').then(() => {
                this.copiedAt = Date.now();
                this.el.copy.textContent = 'Copied';
                setTimeout(() => {
                    if (Date.now() - this.copiedAt >= 1400) this.el.copy.textContent = 'Copy summary';
                }, 1500);
            });
            return;
        }
        this.send(cmd);
    }

    send(cmd, arg) {
        return ipcRenderer
            .invoke('dbdps:cmd', cmd, arg)
            .then((r) => {
                if (r && r.view) this.render(r.view);
                this.focusGame();
                return r;
            })
            .catch(() => this.focusGame());
    }

    onDrag(e) {
        const d = this.drag;
        if (!d) return;
        if (Math.abs(e.clientX - d.x0) + Math.abs(e.clientY - d.y0) > 3) d.moved = true;
        if (!d.moved) return;
        const p = this.panels[d.id];
        p.classList.add('dragging');
        const x = Math.max(0, Math.min(window.innerWidth - 60, e.clientX - d.dx));
        const y = Math.max(0, Math.min(window.innerHeight - 30, e.clientY - d.dy));
        p.style.left = Math.round(x) + 'px';
        p.style.top = Math.round(y) + 'px';
        if (d.id === 'fight') this.dockRotation();
    }

    endDrag() {
        const d = this.drag;
        this.drag = null;
        if (d && d.moved) {
            const p = this.panels[d.id];
            p.classList.remove('dragging');
            const old = this.layoutState.rects[d.id];
            this.saveRect(d.id, {
                x: parseInt(p.style.left, 10) || 0,
                y: parseInt(p.style.top, 10) || 0,
                w: p.offsetWidth,
                h: old && old.h ? old.h : 0
            });
        }
        if (this.resizing) {
            const id = this.resizing;
            this.resizing = null;
            const p = this.panels[id];
            const r = p.getBoundingClientRect();
            this.saveRect(id, { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) });
        }
        if (d) this.focusGame();
    }

    saveRect(id, rect) {
        this.layoutState.rects[id] = rect;
        this.layout();
        this.send('layout', { id, rect });
    }

    /* ---------- layout ---------- */

    geometry() {
        const W = window.innerWidth;
        const H = window.innerHeight;
        const boxW = Math.min(W, H * 1.5);
        const boxH = Math.min(H, W / 1.5);
        const gutter = (W - boxW) / 2;
        const top = (H - boxH) / 2;
        const side = gutter >= SIDE_MIN;
        const width = side ? Math.min(SIDE_MAX, Math.floor(gutter - 16)) : FLOAT_W;
        return { W, H, boxH, gutter, top, side, width };
    }

    place(panel, x, y, w, h, maxH) {
        Object.assign(panel.style, {
            left: Math.round(x) + 'px',
            top: Math.round(y) + 'px',
            width: Math.round(w) + 'px',
            height: h ? Math.round(h) + 'px' : '',
            maxHeight: h ? '' : Math.max(52, Math.round(maxH)) + 'px'
        });
    }

    /** Where a moved window goes: where it was left, kept on screen. */
    placeSaved(panel, r, g) {
        const w = Math.max(120, Math.min(r.w || g.width, g.W));
        const x = Math.max(0, Math.min(r.x, g.W - 60));
        const y = Math.max(0, Math.min(r.y, g.H - 30));
        const h = r.h ? Math.max(52, Math.min(r.h, g.H - y)) : 0;
        this.place(panel, x, y, w, h, g.H - y - 8);
    }

    /** The Rotation window's own place, unless it was moved: right under the Damage Meter. */
    dockRotation() {
        const g = this.geo || this.geometry();
        if (this.layoutState.rects.rotation) return;
        const f = this.panels.fight;
        const p = this.panels.rotation;
        const fr = f.hidden ? null : f.getBoundingClientRect();
        const x = fr ? fr.left : g.side ? g.gutter - 8 - g.width : 16;
        const w = fr ? fr.width : g.width;
        const y = fr ? fr.bottom + GAP : g.top + 8;
        const bottom = g.side ? g.top + g.boxH - 8 : g.H - 8;
        this.place(p, x, y, w, 0, bottom - y);
    }

    layout() {
        if (!this.root) return;
        const g = this.geometry();
        this.geo = g;
        const hidden = Boolean(this.view && this.view.settings.hidden);
        const fs = g.side ? Math.max(11, Math.min(14, g.width / 14)) : 11.5;
        this.root.style.setProperty('--fs', fs.toFixed(1) + 'px');
        this.reveal.hidden = !hidden;
        const fr = this.layoutState.rects.fight;
        Object.assign(this.reveal.style, {
            left: Math.round(fr ? Math.max(4, Math.min(fr.x, g.W - 120)) : g.side ? Math.max(4, g.gutter - 8 - g.width) : 8) + 'px',
            top: Math.round(fr ? Math.max(4, Math.min(fr.y, g.H - 30)) : g.side ? g.top + 8 : 8) + 'px',
            maxWidth: g.width + 'px'
        });
        for (const id of PANELS) this.panels[id].hidden = hidden;
        if (hidden) return;

        const rects = this.layoutState.rects;
        // Damage Meter: top of the left gutter.
        if (rects.fight) this.placeSaved(this.panels.fight, rects.fight, g);
        else if (g.side) this.place(this.panels.fight, g.gutter - 8 - g.width, g.top + 8, g.width, 0, g.boxH - 16);
        else this.place(this.panels.fight, 16, 16, g.width, 0, g.H - 32);
        // Spells: top of the right gutter, as wide as the Damage Meter.
        if (rects.spells) this.placeSaved(this.panels.spells, rects.spells, g);
        else if (g.side) this.place(this.panels.spells, g.W - g.gutter + 8, g.top + 8, g.width, 0, g.boxH - 16);
        else this.place(this.panels.spells, g.W - 16 - g.width, 16, g.width, 0, g.H - 32);
        this.panels.spells.classList.toggle('narrow', this.panels.spells.offsetWidth < SPELLS_NARROW);
        // Rotation: under the Damage Meter.
        if (rects.rotation) this.placeSaved(this.panels.rotation, rects.rotation, g);
        else this.dockRotation();
    }

    /* ---------- rendering ---------- */

    render(view) {
        const firstView = !this.view;
        this.view = view;
        const m = view.meter;
        const t = m.totals;
        const el = this.el;

        const lay = (view.settings && view.settings.layout) || {};
        const layoutKey = JSON.stringify(lay);
        if (firstView || this.lastLayoutKey !== layoutKey) {
            // The main process holds the saved layout; it wins unless a drag is under way.
            this.lastLayoutKey = layoutKey;
            if (!this.drag && !this.resizing) {
                this.layoutState = { rects: Object.assign({}, lay.rects || {}) };
                this.layout();
            }
        }

        el.dot.className = 'dot ' + m.state;
        el.clock.innerHTML = cells(clock(m.elapsedMs));
        el.toggle.textContent = m.state === 'running' ? 'Stop' : m.state === 'stopped' ? 'Resume' : 'Start';
        el.toggle.classList.toggle('stop', m.state === 'running');
        el.toggle.title = (m.state === 'running' ? 'Stop' : 'Start') + ' the timer (F6)';
        el.dps.innerHTML = cells(short(m.dps));
        el.total.textContent = int(t.damage);
        el.casts.textContent = int(t.casts);
        el.hits.textContent = int(t.hits);
        el.crit.textContent = Math.round(m.critRate * 100) + '%';
        el.auto.setAttribute('aria-pressed', String(Boolean(view.settings.autoStart)));

        // Scaling: damage split by the stat each hit scales with.
        const s = m.byStat;
        const sum = s.attack + s.expertise + s.unknown;
        el.split.innerHTML = sum
            ? '<i class="atk" style="width:' + (s.attack / sum) * 100 + '%"></i><i class="exp" style="width:' + (s.expertise / sum) * 100 + '%"></i><i class="unk" style="width:' + (s.unknown / sum) * 100 + '%"></i>'
            : '';
        let legend = '<span><b class="atk"></b>Attack ' + pct(s.attack, sum) + '</span><span><b class="exp"></b>Expertise ' + pct(s.expertise, sum) + '</span>';
        if (s.unknown) legend += '<span><b class="unk"></b>Unclassified ' + pct(s.unknown, sum) + '</span>';
        el.legend.innerHTML = legend;
        el.kinds.textContent = t.damage
            ? 'Over time ' + pct(t.dotDamage, t.damage) + ' of damage. Crits ' + pct(t.critDamage, t.damage) + ' of damage.'
            : 'Direct hits scale with Attack, damage over time with Expertise.';
        const ig = m.ignored;
        el.ignored.hidden = !(ig.hits && m.state !== 'running');
        el.ignored.textContent = ig.hits ? int(ig.hits) + ' hit' + (ig.hits === 1 ? '' : 's') + ' (' + short(ig.damage) + ' damage) landed while the timer was stopped and weren’t counted.' : '';

        this.renderGraph(m);
        this.renderStatus(view);
        this.renderSpells(view);
        this.renderRotation(m);
        if (this.lastHidden !== view.settings.hidden) {
            this.lastHidden = view.settings.hidden;
            this.layout();
        } else if (!this.drag) {
            // The Damage Meter's height moves with its content; the Rotation window follows it.
            this.dockRotation();
        }
    }

    /**
     * DPS over the whole fight: the shaded area is the damage per second in each moment, the
     * line the running average (the big DPS number) as it built up.
     */
    renderGraph(m) {
        const svg = this.el.spark;
        const series = m.dpsSeries || { perSecond: [], running: [], seconds: 0 };
        const per = series.perSecond || [];
        const run = series.running || [];
        if (per.length < 2) {
            svg.innerHTML = '<text x="60" y="21" text-anchor="middle" font-size="7" fill="#b5a983">Starts after 2 s of fighting</text>';
            this.el.gpeak.textContent = '';
            this.el.gend.textContent = '';
            return;
        }
        const smooth = per;
        const peak = series.peak || Math.max.apply(null, per);
        const top = Math.max(Math.max.apply(null, per), Math.max.apply(null, run), 1) * 1.08;
        const n = per.length;
        const xy = (v, i) => ((i / (n - 1)) * 120).toFixed(1) + ',' + (35 - (v / top) * 33).toFixed(1);
        const area = smooth.map(xy).join(' ');
        const line = run.map(xy).join(' ');
        const mid = (35 - ((top / 1.08 / 2) / top) * 33).toFixed(1);
        svg.innerHTML =
            '<line x1="0" x2="120" y1="' + mid + '" y2="' + mid + '" stroke="rgba(184,151,63,0.25)" stroke-width="0.6" vector-effect="non-scaling-stroke" stroke-dasharray="2 2"/>' +
            '<polygon points="0,36 ' + area + ' 120,36" fill="rgba(0,204,255,0.24)"/>' +
            '<polyline points="' + line + '" fill="none" stroke="#00ccff" stroke-width="1.6" vector-effect="non-scaling-stroke"/>';
        this.el.gpeak.innerHTML = 'best 5 s <b>' + esc(compact(peak)) + '</b>';
        this.el.gend.textContent = mmss(series.seconds);
    }

    renderStatus(view) {
        const link = view.link || {};
        const scan = view.scan;
        let html = '<span class="link ' + esc(link.state || '') + '">' + esc(link.text || '') + '</span>';
        if (scan) {
            html += '<span>Spells from your scan of ' + esc(when(scan.scannedAt)) + ' (<a data-act="rescan">check again</a>)</span>';
        }
        if (view.lastExport) {
            html += '<span>Saved ' + esc(view.lastExport.split(/[\\/]/).pop()) + ' (<a data-act="reveal">show</a>)</span>';
        }
        html += '<span>F6 start or stop, F7 reset, F8 hide. Drag a window by its title, resize it from its corner (<a data-act="resetLayout">reset layout</a>).</span>';
        if (this.lastStatus !== html) {
            this.el.status.innerHTML = html;
            this.lastStatus = html;
        }
    }

    /**
     * The Rotation window: the casts in order as one line of text that wraps, "MA2 s2 s3 RA1 s4":
     * s and the hotbar slot for a spell (s1-s6 = keys 1, 2, 3, 4, E, Q), MA or RA and the hits
     * landed for basic attacks in a row. Hover a part for its spell, time and damage.
     */
    renderRotation(m) {
        const rot = m.rotation || { count: 0, casts: 0, entries: [] };
        const list = this.el.rot;
        this.el.rotationSub.textContent = rot.casts ? int(rot.casts) + ' cast' + (rot.casts === 1 ? '' : 's') : '';
        const entries = (rot.entries || []).filter((e) => e.kind !== 'other');
        if (!entries.length) {
            if (!list.querySelector('.empty')) list.innerHTML = '<p class="empty">Your casts show here in order, like MA2 s2 s3 RA1 s4.</p>';
            this.rotKey = '';
            return;
        }
        const stick = this.rotStick;
        const earlier = rot.count > (rot.entries || []).length;
        const parts = entries.map((e, i) => {
            const basic = e.kind === 'melee' || e.kind === 'ranged';
            const name = basic
                ? (e.kind === 'melee' ? 'Melee' : 'Ranged') + ' attacks (' + e.label + '), ' + e.casts + ' in a row'
                : e.label + (e.rank ? ' rank ' + e.rank : '') + (e.slotKey ? ', key ' + e.slotKey : '');
            const tip =
                name + '\n' + clock(e.t) + (basic && e.endT > e.t ? ' to ' + clock(e.endT) : '') + '\n' +
                (e.damage ? int(e.damage) + ' damage, ' + e.hits + ' hit' + (e.hits === 1 ? '' : 's') + (e.crits ? ' (' + e.crits + ' crit)' : '') + (e.dotDamage ? ', ' + int(e.dotDamage) + ' over time' : '') : 'no damage');
            const cls = 't' + (basic ? ' basic' : '') + (!basic && e.crits ? ' crit' : '') + (i === entries.length - 1 ? ' last' : '');
            return '<span class="' + cls + '" title="' + esc(tip) + '">' + esc(e.badge) + '</span>';
        });
        const html = (earlier ? '<span class="t basic" title="Earlier casts are in the export">… </span>' : '') + parts.join(' ');
        if (this.rotKey !== html) {
            list.innerHTML = html;
            this.rotKey = html;
            if (stick) list.scrollTop = list.scrollHeight;
        }
    }

    renderSpells(view) {
        const m = view.meter;
        const list = this.el.spells;
        const equipped = m.equipped || [];
        const others = (m.others || []).filter((r) => r.damage > 0);
        const maxDamage = Math.max(1, ...equipped.map((r) => r.damage), ...others.map((r) => r.damage));
        const scan = view.scan;

        const wanted = [];
        if (equipped.length) {
            wanted.push({ group: scan ? 'Equipped' : 'Hotbar' });
            for (const r of equipped) wanted.push(r);
            if (others.length) wanted.push({ group: 'Other damage' });
        }
        for (const r of others) wanted.push(r);

        if (!wanted.length) {
            const msg = 'Press Start (F6), then fight. Every spell that lands a hit is listed here, numbered by its hotbar slot (1 to 6), with its casts and share of your damage.';
            if (!list.querySelector('.empty')) {
                list.innerHTML = '<p class="empty"></p>';
                this.rowEls.clear();
            }
            list.querySelector('.empty').textContent = msg;
            return;
        }
        const empty = list.querySelector('.empty');
        if (empty) empty.remove();

        const seen = new Set();
        let prev = null;
        for (const item of wanted) {
            const id = item.group ? 'g:' + item.group : 'r:' + item.key;
            seen.add(id);
            let node = this.rowEls.get(id);
            if (!node) {
                node = document.createElement('div');
                node.className = item.group ? 'group' : 'spell';
                this.rowEls.set(id, node);
            }
            if (item.group) {
                node.textContent = item.group;
            } else {
                this.fillSpell(node, item, maxDamage, m.totals.damage);
            }
            const next = prev ? prev.nextSibling : list.firstChild;
            if (next !== node) list.insertBefore(node, next);
            prev = node;
        }
        for (const [id, node] of this.rowEls) {
            if (!seen.has(id)) {
                node.remove();
                this.rowEls.delete(id);
            }
        }
    }

    fillSpell(node, r, maxDamage, total) {
        node.dataset.key = r.key;
        node.classList.toggle('idle', !r.damage && !r.casts);
        const fill = r.damage / maxDamage;
        const st = r.byStat;
        const sum = st.attack + st.expertise + st.unknown || 1;
        const segs =
            '<i class="atk" style="width:' + (st.attack / sum) * 100 + '%"></i>' +
            '<i class="exp" style="width:' + (st.expertise / sum) * 100 + '%"></i>' +
            '<i class="unk" style="width:' + (st.unknown / sum) * 100 + '%"></i>';
        const tip = [r.label + (r.rank ? ', rank ' + r.rank : ''), r.scaling ? 'Stats: ' + r.scaling : ''].filter(Boolean).join('\n');
        let html =
            '<div class="l1">' +
            (r.slot || r.hotkey ? '<kbd>' + esc(r.slot ? String(r.slot) : r.hotkey) + '</kbd>' : '') +
            '<span class="name">' + esc(r.label) + '</span>' +
            (r.rank ? '<span class="rank">r' + esc(r.rank) + '</span>' : '') +
            '</div>' +
            '<div class="bar"><span class="fill" style="width:' + (fill * 100).toFixed(1) + '%">' + segs + '</span></div>' +
            '<div class="l2"><span class="dmg">' + short(r.damage) + '</span><span>' + pct(r.damage, total) + '</span><span class="casts">' + int(r.casts) + ' cast' + (r.casts === 1 ? '' : 's') + '</span></div>';
        if (this.open.has(r.key)) {
            html += '<dl class="more">' +
                '<dt>DPS</dt><dd>' + int(r.dps) + '</dd>' +
                '<dt>Hits</dt><dd>' + int(r.hits) + '</dd>' +
                '<dt>Crit rate</dt><dd>' + Math.round(r.critRate * 100) + '%</dd>' +
                '<dt>Average hit</dt><dd>' + int(r.avgHit) + '</dd>' +
                '<dt>Biggest hit</dt><dd>' + int(r.maxHit) + '</dd>' +
                (r.dotDamage ? '<dt>Over time</dt><dd>' + short(r.dotDamage) + ' (' + int(r.dotTicks) + ' ticks)</dd>' : '') +
                (r.summonDamage ? '<dt>By summons</dt><dd>' + short(r.summonDamage) + '</dd>' : '') +
                '<dt>Attack-scaled</dt><dd>' + pct(st.attack, r.damage) + '</dd>' +
                '<dt>Expertise-scaled</dt><dd>' + pct(st.expertise, r.damage) + '</dd>' +
                (r.scaling ? '<dd class="desc">' + esc(r.scaling) + '</dd>' : '') +
                '</dl>';
        }
        if (node._html !== html) {
            node.innerHTML = html;
            node._html = html;
            node.title = tip;
        }
    }
}

function boot() {
    if (!onGamePage() || document.getElementById('dbdps')) return;
    loadFonts();
    new Overlay().mount();
}

if (/^https?:$/.test(location.protocol)) {
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', boot, { once: true });
    } else {
        boot();
    }
}
