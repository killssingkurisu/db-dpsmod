'use strict';

/**
 * The launcher's corner menu, drawn over every page of the game window (bottom right), and the
 * "update ready" card above it.
 *
 *   [DPS Launcher 1.6.0]            closed: small and dim, out of the way of the game
 *   [Update 1.6.1 ready]            when a new version has downloaded: the card opens once,
 *                                   with "Restart and update"; "Later" folds it into the chip
 *
 * Clicking the chip opens the menu: update status and "Check for updates", reload, full
 * screen, the exports and log folders, the releases page.
 *
 * Everything lives in a shadow root, so the game page's styles and this one's never meet. On the
 * launcher's own pages (file://) the same commands are also offered to the page as
 * window.dbLauncher; the game website never gets them.
 */

const { ipcRenderer, contextBridge } = require('electron');
const fs = require('fs');
const path = require('path');

const CSS = `
:host { all: initial; }
.wrap {
  position: fixed; right: 10px; bottom: 10px; z-index: 2147483600;
  display: flex; flex-direction: column; align-items: flex-end; gap: 8px;
  font-family: "DBDPS Averia", Georgia, "Times New Roman", serif; font-size: 12px; line-height: 1.4;
  color: #eee2bc; -webkit-font-smoothing: antialiased; user-select: none; pointer-events: none;
  max-width: min(320px, calc(100vw - 20px));
}
.wrap > * { pointer-events: auto; }
button { font: inherit; color: inherit; cursor: pointer; }
.chip {
  display: inline-flex; align-items: center; gap: 7px; padding: 4px 10px 4px 8px;
  background: rgba(28, 26, 13, 0.82); border: 1px solid rgba(184, 151, 63, 0.55); border-radius: 999px;
  opacity: 0.55; transition: opacity 120ms;
}
.chip:hover, .chip:focus-visible, .chip.open, .chip.ready { opacity: 1; }
.chip:focus-visible, .card button:focus-visible, .menu button:focus-visible { outline: 2px solid #00ccff; outline-offset: 2px; }
.chip .ver { color: #b5a983; }
.dot { width: 7px; height: 7px; border-radius: 50%; background: #b5a983; flex: none; }
.chip.ready { background: #e3b341; border-color: #f5d670; color: #1c1a0d; font-weight: 700; }
.chip.ready .dot { background: #1c1a0d; }
.chip.ready .ver { color: #1c1a0d; }
.chip.busy .dot { background: #00ccff; animation: pulse 1.2s ease-in-out infinite; }
.chip.error .dot { background: #d6453d; }
@keyframes pulse { 50% { opacity: 0.25; } }
@media (prefers-reduced-motion: reduce) { .chip.busy .dot { animation: none; } }

.card, .menu {
  width: 300px; max-width: 100%; box-sizing: border-box;
  background: rgba(28, 26, 13, 0.96); border: 1px solid #b8973f; border-radius: 5px;
  box-shadow: inset 0 0 0 3px #1c1a0d, inset 0 0 0 4px rgba(184, 151, 63, 0.38), 0 8px 22px rgba(0,0,0,0.45);
  padding: 12px 13px 11px;
}
.card h2, .menu h2 { margin: 0 0 4px; font-size: 14px; font-weight: 700; color: #f5d670; }
.card p, .menu p { margin: 0 0 8px; }
.muted { color: #b5a983; }
.notes {
  margin: 0 0 10px; padding: 7px 8px; max-height: 120px; overflow: auto; white-space: pre-wrap;
  background: #2a2612; border-radius: 3px; color: #eee2bc; font-size: 11.5px; user-select: text;
}
.row { display: flex; gap: 8px; flex-wrap: wrap; }
.primary {
  padding: 5px 12px; border-radius: 3px; border: 1px solid #f5d670; background: #e3b341; color: #1c1a0d; font-weight: 700;
}
.primary:hover { background: #ecc85b; }
.plain { padding: 5px 10px; border-radius: 3px; border: 1px solid rgba(184, 151, 63, 0.55); background: transparent; }
.plain:hover { border-color: #b8973f; background: rgba(184, 151, 63, 0.12); }
.menu .head { display: flex; justify-content: space-between; align-items: baseline; gap: 8px; }
.menu .close { border: 0; background: none; padding: 0 2px; font-size: 16px; line-height: 1; color: #b5a983; }
.menu .close:hover { color: #eee2bc; }
.menu .status { padding: 8px 0 9px; margin-bottom: 6px; border-bottom: 1px solid rgba(184, 151, 63, 0.3); }
.menu .status p { margin-bottom: 6px; }
.menu .status p:last-child { margin-bottom: 0; }
.menu ul { list-style: none; margin: 0; padding: 0; }
.menu li button {
  display: flex; justify-content: space-between; width: 100%; text-align: left; padding: 5px 6px; border: 0; border-radius: 3px; background: none;
}
.menu li button:hover { background: rgba(184, 151, 63, 0.16); }
.menu li button:disabled { opacity: 0.45; cursor: default; background: none; }
.menu li .key { color: #b5a983; }
.bar { height: 4px; background: #2a2612; border-radius: 2px; overflow: hidden; margin-top: 4px; }
.bar i { display: block; height: 100%; background: #00ccff; }
[hidden] { display: none !important; }
`;

function loadFonts() {
    const dir = path.join(__dirname, '..', 'fonts');
    for (const [file, weight] of [['averia-serif-libre-400.woff2', '400'], ['averia-serif-libre-700.woff2', '700']]) {
        try {
            const face = new FontFace('DBDPS Averia', fs.readFileSync(path.join(dir, file)), { weight });
            document.fonts.add(face);
            face.load().catch(() => {});
        } catch (_e) {
            // Georgia stands in
        }
    }
}

function ago(ms) {
    const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
    if (s < 60) return 'just now';
    const m = Math.round(s / 60);
    if (m < 60) return m + ' min ago';
    const h = Math.round(m / 60);
    return h + (h === 1 ? ' hour ago' : ' hours ago');
}

function el(tag, attrs, children) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
        if (k === 'text') e.textContent = v;
        else if (k === 'on') for (const [ev, fn] of Object.entries(v)) e.addEventListener(ev, fn);
        else if (v !== false && v !== null && v !== undefined) e.setAttribute(k, v === true ? '' : v);
    }
    for (const c of [].concat(children || [])) if (c) e.append(c);
    return e;
}

class LauncherUi {
    constructor() {
        this.state = null;
        this.menuOpen = false;
        this.cardDismissedFor = '';
        this.busy = '';
        this.host = document.createElement('db-launcher-ui');
        this.root = this.host.attachShadow({ mode: 'closed' });
        this.root.append(el('style', { text: CSS }));
        this.wrap = el('div', { class: 'wrap' });
        this.card = el('section', { class: 'card', role: 'status', hidden: true });
        this.menu = el('section', { class: 'menu', role: 'dialog', 'aria-label': 'DB DPS Launcher', hidden: true });
        this.chip = el('button', { class: 'chip', type: 'button', 'aria-haspopup': 'dialog', on: { click: () => this.toggleMenu() } });
        this.wrap.append(this.card, this.menu, this.chip);
        this.root.append(this.wrap);
        (document.body || document.documentElement).append(this.host);
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && this.menuOpen) this.toggleMenu(false);
        });
        document.addEventListener('mousedown', (e) => {
            if (this.menuOpen && !e.composedPath().includes(this.host)) this.toggleMenu(false);
        });
        ipcRenderer.on('launcher:state', (_e, s) => this.render(s));
        ipcRenderer.invoke('launcher:hello').then((s) => this.render(s)).catch(() => {});
        setInterval(() => this.menuOpen && this.render(this.state), 30000);
    }

    async cmd(name) {
        this.busy = name;
        this.render(this.state);
        try {
            const r = await ipcRenderer.invoke('launcher:cmd', name);
            if (r && r.state) this.state = r.state;
        } finally {
            this.busy = '';
            this.render(this.state);
        }
    }

    toggleMenu(open) {
        this.menuOpen = open === undefined ? !this.menuOpen : open;
        this.render(this.state);
    }

    render(s) {
        if (!s) return;
        this.state = s;
        const u = s.update || {};
        const ready = u.state === 'ready';

        // The chip.
        this.chip.className = 'chip' + (ready ? ' ready' : '') + (u.state === 'downloading' || u.state === 'checking' ? ' busy' : '') + (u.state === 'error' ? ' error' : '') + (this.menuOpen ? ' open' : '');
        this.chip.setAttribute('aria-expanded', String(this.menuOpen));
        this.chip.replaceChildren(
            el('span', { class: 'dot' }),
            ready
                ? el('span', { text: 'Update ' + u.version + ' ready' })
                : u.state === 'downloading'
                ? el('span', { text: 'Updating ' + (u.percent || 0) + '%' })
                : el('span', {}, ['DPS Launcher ', el('span', { class: 'ver', text: s.version })])
        );

        // The "ready" card: opens once per downloaded version, until "Later".
        const showCard = ready && this.cardDismissedFor !== u.version && !this.menuOpen;
        this.card.hidden = !showCard;
        if (showCard) {
            this.card.replaceChildren(
                el('h2', { text: 'Version ' + u.version + ' is ready' }),
                el('p', { class: 'muted', text: 'Restarting installs it. The game closes and the launcher opens again in a few seconds.' }),
                u.notes ? el('div', { class: 'notes', text: u.notes }) : null,
                el('div', { class: 'row' }, [
                    el('button', { class: 'primary', type: 'button', text: this.busy === 'installUpdate' ? 'Restarting…' : 'Restart and update', on: { click: () => this.cmd('installUpdate') } }),
                    el('button', {
                        class: 'plain',
                        type: 'button',
                        text: 'Later',
                        on: {
                            click: () => {
                                this.cardDismissedFor = u.version;
                                this.render(this.state);
                            }
                        }
                    })
                ])
            );
        }

        // The menu.
        this.menu.hidden = !this.menuOpen;
        if (!this.menuOpen) return;
        const status = [];
        if (u.state === 'off') status.push(el('p', { class: 'muted', text: u.offReason }));
        else if (u.state === 'idle' || u.state === 'checking') status.push(el('p', { text: 'Checking for updates…' }));
        else if (u.state === 'current') status.push(el('p', { text: u.manual && Date.now() - u.checkedAt < 60000 ? 'You have the latest version.' : 'Up to date. Checked ' + ago(u.checkedAt) + '.' }));
        else if (u.state === 'downloading') {
            status.push(el('p', { text: 'Downloading version ' + u.version + ': ' + (u.percent || 0) + '%' }));
            status.push(el('div', { class: 'bar' }, [el('i', { style: 'width:' + (u.percent || 0) + '%' })]));
        } else if (ready) {
            status.push(el('p', { text: 'Version ' + u.version + ' is ready to install.' }));
            if (u.notes) status.push(el('div', { class: 'notes', text: u.notes }));
            status.push(el('button', { class: 'primary', type: 'button', text: this.busy === 'installUpdate' ? 'Restarting…' : 'Restart and update', on: { click: () => this.cmd('installUpdate') } }));
        } else if (u.state === 'error') status.push(el('p', { text: 'Couldn’t check for updates: ' + u.error }));

        const item = (label, key, name, disabled) =>
            el('li', {}, [el('button', { type: 'button', disabled: Boolean(disabled), on: { click: () => this.cmd(name) } }, [el('span', { text: label }), key ? el('span', { class: 'key', text: key }) : null])]);
        this.menu.replaceChildren(
            el('div', { class: 'head' }, [
                el('h2', { text: 'DB DPS Launcher ' + s.version }),
                el('button', { class: 'close', type: 'button', 'aria-label': 'Close', text: '×', on: { click: () => this.toggleMenu(false) } })
            ]),
            el('div', { class: 'status' }, status),
            el('ul', {}, [
                u.state !== 'off' && !ready ? item(this.busy === 'checkUpdates' ? 'Checking…' : 'Check for updates', '', 'checkUpdates', this.busy === 'checkUpdates' || u.state === 'downloading') : null,
                item(s.page === 'game' ? 'Reload the game' : 'Open the game', 'F5', 'reload'),
                item(s.fullScreen ? 'Leave full screen' : 'Full screen', 'F11', 'fullscreen'),
                item('Open the exports folder', '', 'openExports'),
                item('Open the log folder', '', 'openLogs'),
                item('Releases on GitHub', '', 'openProject')
            ])
        );
    }
}

if (location.protocol === 'file:') {
    // The launcher's own pages (offline, Flash missing) ask for the same commands.
    contextBridge.exposeInMainWorld('dbLauncher', {
        cmd: (name) => ipcRenderer.invoke('launcher:cmd', name),
        state: () => ipcRenderer.invoke('launcher:hello'),
        onState: (fn) => ipcRenderer.on('launcher:state', (_e, s) => fn(s))
    });
}

function boot() {
    if (window.top !== window) return; // frames inside the page
    loadFonts();
    window.__dbLauncherUi = new LauncherUi();
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true });
else boot();
