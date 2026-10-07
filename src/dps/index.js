'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const { spawnSync } = require('child_process');

const { RelayHub } = require('./relay');
const { WebProxy } = require('./httpProxy');
const swfpatch = require('./swfpatch');
const { DpsMeter } = require('./meter');
const { PowerTable, dataFromSwz, DATA_VERSION } = require('./powers');
const { BossTable, bossesFromSwz } = require('./entities');
const { SpellScanStore } = require('./spellScans');
const exporter = require('./exporter');

/** The launcher's version (package.json), which is also the meter's. */
const VERSION = (() => {
    try {
        return require('../../package.json').version;
    } catch (_e) {
        return 'dev';
    }
})();
const SOURCE = 'DB DPS Launcher ' + VERSION;
const PORT_BASE = 47690;
const PORT_LAST = 47890;
/** The live client logs in here (LinkUpdater.const_1264, Connection.LOGINSERVER_PORT); the SWF itself is what counts. */
const LOGIN_HOST = 'dungeonblitzr.theminesa.studio';
const LOGIN_PORT = 8080;

/** Log lines go to the console and, once the launcher's data folder is known, to dps-overlay.log there. */
const logState = { file: '', pending: [] };

function log(message) {
    const line = new Date().toISOString() + ' ' + message;
    console.log('[DPS] ' + message);
    if (!logState.file) {
        logState.pending.push(line);
        return;
    }
    try {
        fs.appendFileSync(logState.file, line + '\n');
    } catch (_e) {
        // logging is best effort
    }
}

function openLog(file) {
    logState.file = file;
    try {
        fs.writeFileSync(file, logState.pending.join('\n') + (logState.pending.length ? '\n' : ''));
    } catch (_e) {
        logState.file = '';
    }
    logState.pending = [];
}

/**
 * The game websites the launcher may open: the official host and each other plain-HTTP game
 * address it's given (a server on this computer is left alone). Their HTTP traffic is mapped
 * onto the meter's web proxy so it can hand the game a DungeonBlitz.swf that logs in through the
 * relay.
 */
function webHosts(urls) {
    const out = [{ host: LOGIN_HOST, port: 80 }];
    for (const url of urls || []) {
        try {
            const u = new URL(String(url));
            if (u.protocol !== 'http:') continue;
            const host = u.hostname.toLowerCase();
            const port = Number(u.port) || 80;
            if (/^(127\.|localhost$|\[?::1\]?$)/.test(host)) continue;
            if (!out.some((w) => w.host === host && w.port === port)) out.push({ host, port });
        } catch (_e) {
            // not a URL
        }
    }
    return out;
}

/**
 * Free loopback ports, found before Chromium starts. The host mapping has to be on the command
 * line before the network service launches, which is before anything asynchronous can run in
 * this process, so a short-lived copy of this executable (in Node mode) does the probing.
 */
function findFreePorts(count) {
    const script =
        "const net=require('net');const out=[];let p=" + PORT_BASE + ';' +
        '(function next(){if(out.length>=' + count + '||p>' + PORT_LAST + '){process.stdout.write(JSON.stringify(out));return;}' +
        "const port=p++;const s=net.createServer();s.once('error',()=>next());" +
        "s.listen(port,'127.0.0.1',()=>s.close(()=>{out.push(port);next();}));})();";
    const env = Object.assign({}, process.env, { ELECTRON_RUN_AS_NODE: '1' });
    const r = spawnSync(process.execPath, ['-e', script], { env, encoding: 'utf8', timeout: 10000, windowsHide: true });
    if (r.error) {
        throw r.error;
    }
    const ports = JSON.parse(String(r.stdout || '[]').trim() || '[]');
    if (!Array.isArray(ports) || ports.length < count) {
        throw new Error('no free loopback ports between ' + PORT_BASE + ' and ' + PORT_LAST);
    }
    return ports;
}

function fetchBuffer(url, timeoutMs, okStatuses) {
    return new Promise((resolve, reject) => {
        const lib = url.startsWith('https:') ? https : http;
        const req = lib.get(url, { timeout: timeoutMs, headers: { 'cache-control': 'no-cache' } }, (res) => {
            if (!(okStatuses || [200]).includes(res.statusCode)) {
                res.resume();
                reject(new Error('HTTP ' + res.statusCode));
                return;
            }
            const parts = [];
            res.on('data', (d) => parts.push(d));
            res.on('end', () => resolve(Buffer.concat(parts)));
            res.on('error', reject);
        });
        req.on('timeout', () => req.destroy(new Error('timed out')));
        req.on('error', reject);
    });
}

function stamp(d) {
    const pad = (x) => String(x).padStart(2, '0');
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + pad(d.getMinutes());
}

function safeFileName(s) {
    return String(s || '').replace(/[\\/:*?"<>|]+/g, '').trim() || 'character';
}

class DpsOverlay {
    /** gameUrls: the game addresses the launcher opens (the official one is always included). */
    constructor({ gameUrls } = {}) {
        this.gameUrls = gameUrls || [];
        this.electron = require('electron');
        this.app = this.electron.app;
        this.enabled = false;
        this.web = [];
        this.proxy = null;
        this.hub = null;
        this.hubError = '';
        this.swfFv = '';
        this.presence = { checkedAt: 0, playing: false };
        this.meter = new DpsMeter();
        this.scans = null;
        this.powersInfo = { source: 'none', count: 0 };
        this.gameContents = null;
        this.gameOrigin = '';
        this.livePowersFrom = '';
        this.character = '';
        this.className = '';
        this.level = '';
        this.enteredUnmapped = '';
        this.gameLoadedAt = 0;
        this.dirty = true;
        this.lastSent = 0;
        this.lastExport = '';
        this.settings = { autoStart: false, dungeonMode: false, hidden: false, layout: { rects: {} } };
        this.bosses = new BossTable(null);
        this.bossesFrom = '';
        this.meter.on('change', () => {
            this.dirty = true;
        });
        this.meter.on('ignored', () => {
            this.dirty = true;
        });
    }

    get preloadPath() {
        return path.join(__dirname, 'preload.js');
    }

    /** Synchronous, before 'ready': picks the web proxy's port and maps the game website onto it. */
    prepare() {
        if (process.env.DUNGEON_BLITZ_DPS === '0') {
            log('Off (DUNGEON_BLITZ_DPS=0).');
            return false;
        }
        this.web = webHosts(this.gameUrls);
        const [proxyPort] = findFreePorts(1);
        this.proxy = new WebProxy({ listenPort: proxyPort, hosts: this.web, patchSwf: (buf) => this.patchGameSwf(buf) });
        // Chromium honours these for the page and for Flash's HTTP requests (not for Flash's
        // sockets, which is why the SWF itself is pointed at the relay).
        const rules = this.web.map((w) => 'MAP ' + w.host + ':' + w.port + ' 127.0.0.1:' + proxyPort);
        const existing = this.app.commandLine.getSwitchValue('host-resolver-rules');
        this.app.commandLine.appendSwitch('host-resolver-rules', (existing ? existing + ', ' : '') + rules.join(', '));
        log('Game website routed through the meter: ' + rules.join(', '));
        this.enabled = true;

        this.app.on('web-contents-created', (_e, wc) => this.watchContents(wc));
        this.app.whenReady().then(() => this.onReady()).catch((err) => log('Start failed: ' + ((err && err.stack) || err)));
        return true;
    }

    async onReady() {
        const { session, ipcMain } = this.electron;
        openLog(path.join(this.app.getPath('userData'), 'dps-overlay.log'));
        log('DB DPS Launcher ' + VERSION + ', Electron ' + process.versions.electron);
        this.loadSettings();
        this.meter.autoStart = Boolean(this.settings.autoStart);
        this.meter.setDungeonMode(Boolean(this.settings.dungeonMode));

        // The game page gets the overlay through a session preload; on the launcher's own pages
        // (file://) it does nothing.
        const preloads = session.defaultSession.getPreloads();
        if (!preloads.includes(this.preloadPath)) {
            session.defaultSession.setPreloads(preloads.concat([this.preloadPath]));
        }
        ipcMain.handle('dbdps:cmd', (event, cmd, arg) => this.command(event, cmd, arg));

        this.loadBundledPowers();
        this.loadBundledBosses();
        this.scans = new SpellScanStore({ documents: this.app.getPath('documents') });
        this.scans.on('change', (scan) => this.applyScan(scan));
        this.scans.refresh();
        this.scans.watch();

        this.hub = new RelayHub();
        this.hub.on('connection', (relay, tracker) => this.followConnection(relay, tracker));
        this.hub.on('redirect', (relay, info) => this.onRedirect(relay, info));
        this.hub.on('relay', (relay) => log('Relay for ' + relay.label + ' listening on 127.0.0.1:' + relay.listenPort));
        this.hub.on('status', () => {
            this.dirty = true;
        });
        const policy = await this.hub.startPolicyServer();
        log(policy ? 'Answering Flash socket-policy requests on 127.0.0.1:' + this.hub.policyPort : 'Port ' + this.hub.policyPort + ' is taken (' + this.hub.policyError + '); the relays answer policy requests themselves');
        try {
            await this.hub.relayFor(LOGIN_HOST, LOGIN_PORT);
        } catch (err) {
            this.hubError = String((err && err.message) || err);
            log('No relay port: ' + this.hubError);
        }

        this.proxy.on('request', (r) => this.onWebRequest(r));
        this.proxy.on('swf', (info) => {
            const rep = info.report || {};
            log(info.ok
                ? 'Served DungeonBlitz.swf logging in through 127.0.0.1:' + this.loginRelayPort(rep) + ' instead of ' + rep.originalHost + ':' + rep.originalPort +
                  (rep.dummyDotPatches ? ', with training-dummy DoT ticks visible' : ', without training-dummy DoT ticks (check not found)')
                : 'Served the original DungeonBlitz.swf: ' + info.error);
            this.dirty = true;
        });
        const ok = await this.proxy.listen();
        log(ok ? 'Web proxy listening on 127.0.0.1:' + this.proxy.listenPort : "Web proxy couldn't listen on " + this.proxy.listenPort + ': ' + this.proxy.error);

        setInterval(() => {
            this.meter.tick(); // Dungeon mode's 3-second rule
            this.push();
        }, 250);
        setInterval(() => this.checkPresence(), 10000);
        this.app.on('before-quit', () => {
            if (this.hub) this.hub.close();
            if (this.proxy) this.proxy.close();
            if (this.scans) this.scans.close();
        });
    }

    /** Hands the game a copy of DungeonBlitz.swf whose login connection goes to the relay. */
    async patchGameSwf(buf) {
        const target = swfpatch.readLoginTarget(buf);
        if (!target) return { swf: buf, report: { ok: false } };
        const relay = await this.hub.relayFor(target.host, target.port);
        return swfpatch.patchSwf(buf, { port: relay.listenPort });
    }

    loginRelayPort(report) {
        const r = this.hub && report ? this.hub.find(report.originalHost, report.originalPort) : null;
        return r ? r.listenPort : '?';
    }

    onWebRequest(r) {
        const url = 'http://' + r.host + r.url;
        if (/\/DungeonBlitz\.swf/i.test(r.url)) {
            const fv = /[?&]fv=([^&]+)/.exec(r.url);
            if (fv) this.swfFv = decodeURIComponent(fv[1]);
        }
        if (/\/Game\.swz(\?|$)/i.test(r.url) && (r.status === 200 || r.status === 304)) {
            this.loadLivePowers(url.replace(/\?.*$/, ''));
        }
        if (/\/Login\.swz(\?|$)/i.test(r.url) && (r.status === 200 || r.status === 304)) {
            this.loadLiveBosses(url.replace(/\?.*$/, ''));
        }
    }

    onRedirect(relay, info) {
        if (info.ok) {
            if (info.to) log('Entering ' + (info.level || 'a level') + ': ' + info.from + ' now goes through ' + info.to);
            this.enteredUnmapped = '';
        } else {
            log('Entering ' + (info.level || 'a level') + ' on ' + info.from + ', which the meter could not relay');
            this.enteredUnmapped = info.from;
        }
        this.dirty = true;
    }

    /**
     * Asks the website whether this computer has a character in game. Used only to tell
     * "logged in without the meter" apart from "not logged in yet".
     */
    async checkPresence() {
        if (!this.gameContents || !this.gameOrigin || !/^http:/.test(this.gameOrigin)) return;
        // A level change closes one connection and opens the next; don't ask in between.
        if (this.hub && this.hub.all.some((r) => r.open.size > 0 || Date.now() - r.lastPacketAt < 20000)) {
            this.presence = { checkedAt: 0, playing: false };
            return;
        }
        try {
            const body = await fetchBuffer(this.gameOrigin + '/api/presence/self', 8000, [200, 404, 409]);
            const data = body.length ? JSON.parse(body.toString('utf8')) : null;
            this.presence = { checkedAt: Date.now(), playing: Boolean(data && data.session) };
        } catch (_e) {
            this.presence = { checkedAt: Date.now(), playing: false };
        }
        this.dirty = true;
    }

    /* ---------- data ---------- */

    loadBundledPowers() {
        let data = null;
        try {
            data = JSON.parse(fs.readFileSync(this.cachePath(), 'utf8'));
            // A cache from an older layout lacks fields the meter now reads (which skill a summon
            // belongs to); the bundled table stands in until the game's own Game.swz loads.
            if (!data || (data.version || 1) < DATA_VERSION || !Array.isArray(data.powers)) throw new Error('old cache');
            this.powersInfo = { source: 'cached ' + (data.source || ''), count: data.powers.length };
        } catch (_e) {
            data = null;
        }
        if (!data) {
            data = JSON.parse(fs.readFileSync(path.join(__dirname, 'powers-snapshot.json'), 'utf8'));
            this.powersInfo = { source: 'bundled ' + (data.source || ''), count: data.powers.length };
        }
        this.meter.setPowers(new PowerTable(data));
    }

    cachePath() {
        return path.join(this.app.getPath('userData'), 'dps-powers-cache.json');
    }

    async loadLivePowers(url) {
        if (!url || this.livePowersFrom === url) {
            return;
        }
        this.livePowersFrom = url;
        try {
            const buf = await fetchBuffer(url, 20000);
            const data = dataFromSwz(buf, url + ' (' + new Date().toISOString().slice(0, 10) + ')');
            this.meter.setPowers(new PowerTable(data));
            this.powersInfo = { source: 'live ' + url, count: data.powers.length };
            try {
                fs.writeFileSync(this.cachePath(), JSON.stringify(data));
            } catch (_e) {
                // the cache is a convenience
            }
            log('Spell data loaded from ' + url + ' (' + data.powers.length + ' powers)');
        } catch (err) {
            log('Live spell data unavailable from ' + url + ' (' + ((err && err.message) || err) + '); using ' + this.powersInfo.source);
        }
        this.dirty = true;
    }

    /** Which monsters are bosses (EntRank Boss), for Dungeon mode: bundled, then the game's own Login.swz. */
    loadBundledBosses() {
        try {
            this.bosses = new BossTable(JSON.parse(fs.readFileSync(path.join(__dirname, 'bosses-snapshot.json'), 'utf8')));
        } catch (err) {
            log('No bundled boss list: ' + ((err && err.message) || err));
        }
    }

    async loadLiveBosses(url) {
        if (!url || this.bossesFrom === url) return;
        this.bossesFrom = url;
        try {
            const data = bossesFromSwz(await fetchBuffer(url, 30000), url);
            this.bosses = new BossTable(data);
            log('Boss list loaded from ' + url + ' (' + this.bosses.size + ' bosses)');
        } catch (err) {
            log('Live boss list unavailable from ' + url + ' (' + ((err && err.message) || err) + '); using the bundled one (' + this.bosses.size + ')');
        }
    }

    applyScan(scan) {
        this.meter.setSpellScan(scan);
        if (scan && scan.className && (!this.character || scan.character.toLowerCase() === this.character.toLowerCase())) {
            this.className = scan.className;
        }
        this.dirty = true;
    }

    followConnection(relay, tracker) {
        log('Game connected through the meter (' + tracker.label + ')');
        tracker.on('closed', () =>
            log(
                'Connection closed (' + tracker.label + ', ' + tracker.packets.up + ' packets out, ' + tracker.packets.down + ' in' +
                    (tracker.dummyTicksKept ? ', ' + tracker.dummyTicksKept + ' training-dummy DoT ticks counted and kept from the server' : '') +
                    ')'
            )
        );
        tracker.on('character', ({ id, name }) => log('Your character: ' + name + ' (entity ' + id + ')'));
        tracker.on('character', ({ name }) => {
            if (name && name !== this.character) {
                this.character = name;
                this.className = '';
                if (this.scans) {
                    this.scans.setCharacter(name);
                    this.applyScan(this.scans.current);
                }
                this.dirty = true;
            }
        });
        tracker.on('cast', (e) => this.meter.recordCast(e));
        tracker.on('damage', (e) => this.meter.recordDamage(e));
        tracker.on('procApplied', (e) => this.meter.recordProc(e));
        // Dungeon mode: deaths, bosses and the dungeon's progress.
        tracker.isBoss = (name) => this.bosses.has(name);
        tracker.on('died', () => {
            log('You died');
            this.meter.playerDied();
        });
        tracker.on('revived', () => this.meter.playerRevived());
        tracker.on('bossDied', ({ name }) => {
            log('Boss defeated: ' + this.bosses.displayName(name) + ' (' + name + ')');
            this.meter.bossDied(this.bosses.displayName(name));
        });
        tracker.on('completion', (percent) => this.meter.levelProgress(percent));
        tracker.on('levelComplete', ({ from }) => {
            log('Dungeon complete (' + from + ')');
            this.meter.levelComplete();
        });
        tracker.on('enterWorld', (w) => {
            this.level = w.level || this.level;
            this.meter.noteLevel(this.level);
            this.dirty = true;
        });
    }

    /* ---------- windows ---------- */

    watchContents(wc) {
        wc.on('did-finish-load', () => {
            const url = wc.getURL();
            if (!/^https?:/i.test(url)) {
                return;
            }
            this.gameContents = wc;
            this.gameLoadedAt = Date.now();
            try {
                this.gameOrigin = new URL(url).origin;
            } catch (_e) {
                this.gameOrigin = '';
            }
            // Normally the game's own request for Game.swz names the file; this is the fallback.
            setTimeout(() => {
                if (!this.livePowersFrom && this.gameOrigin) {
                    this.loadLivePowers(this.gameOrigin + '/p/' + (this.swfFv || 'cbp') + '/Game.swz');
                }
            }, 30000);
            this.dirty = true;
        });
        wc.on('destroyed', () => {
            if (this.gameContents === wc) this.gameContents = null;
        });
        wc.on('before-input-event', (event, input) => {
            if (wc !== this.gameContents || input.type !== 'keyDown' || input.isAutoRepeat) {
                return;
            }
            if (input.control || input.alt || input.meta) {
                return;
            }
            const handled = { F6: 'toggle', F7: 'reset', F8: 'hide' }[input.key];
            if (handled) {
                event.preventDefault();
                this.command(null, handled);
            }
        });
    }

    push() {
        const wc = this.gameContents;
        if (!wc || wc.isDestroyed()) {
            return;
        }
        const now = Date.now();
        // While the clock runs the numbers move every frame of this timer; otherwise only on change,
        // plus a slow heartbeat for the link status.
        if (!this.dirty && this.meter.state !== 'running' && now - this.lastSent < 2000) {
            return;
        }
        this.dirty = false;
        this.lastSent = now;
        wc.send('dbdps:snapshot', this.view());
    }

    view() {
        return {
            version: VERSION,
            meter: this.meter.snapshot(),
            character: this.character,
            className: this.className,
            level: this.level,
            link: this.linkStatus(),
            scan: this.scans ? this.scans.status() : null,
            powers: this.powersInfo,
            settings: this.settings,
            lastExport: this.lastExport
        };
    }

    linkStatus() {
        if (!this.enabled) return { state: 'off', text: 'The meter is off.' };
        const proxy = this.proxy;
        if (proxy && !proxy.listening && proxy.error) {
            return { state: 'error', text: "Couldn't open the meter's local port " + proxy.listenPort + ' (' + proxy.error + '). Restart the launcher.' };
        }
        if (this.hubError) {
            return { state: 'error', text: "Couldn't open a local port for the game connection (" + this.hubError + ').' };
        }
        if (this.enteredUnmapped) {
            return { state: 'error', text: 'This level runs on ' + this.enteredUnmapped + ', which the meter couldn’t relay.' };
        }
        const relays = this.hub ? this.hub.all : [];
        const open = relays.reduce((n, r) => n + r.open.size, 0);
        if (open > 0) return { state: 'live', text: this.character ? 'Reading hits for ' + this.character : 'Connected, waiting for your character' };
        const swf = proxy && proxy.swf;
        if (swf && !swf.ok) {
            return { state: 'error', text: "Couldn't point the game at the meter (" + swf.error + ').' };
        }
        if (!swf && this.gameLoadedAt && Date.now() - this.gameLoadedAt > 20000) {
            const https = /^https:/.test(this.gameOrigin);
            return {
                state: 'error',
                text: https ? 'The meter reads the http:// game page only; this one is https.' : 'The game loaded without the meter. Restart the launcher.'
            };
        }
        const ever = relays.reduce((n, r) => n + r.connections, 0);
        if (this.presence.playing && Date.now() - this.presence.checkedAt < 30000) {
            // The website answers per computer, so before this launcher has ever connected that
            // character is most likely in another launcher or a browser.
            if (!ever) return { state: 'waiting', text: 'A character from this computer is in game in another launcher or browser. Log in here to read hits.' };
            return { state: 'error', text: 'Your character is in game, but not through the meter. Restart the launcher.' };
        }
        return { state: 'waiting', text: ever ? 'Waiting for the game to reconnect' : 'Log in to start reading hits' };
    }

    /* ---------- commands from the overlay and hotkeys ---------- */

    async command(event, cmd, arg) {
        const m = this.meter;
        switch (cmd) {
            case 'hello':
                break;
            case 'start':
                m.start();
                break;
            case 'stop':
                m.stop();
                break;
            case 'toggle':
                m.toggle();
                break;
            case 'reset':
                m.reset();
                break;
            case 'hide':
                this.settings.hidden = !this.settings.hidden;
                this.saveSettings();
                break;
            case 'show':
                this.settings.hidden = false;
                this.saveSettings();
                break;
            case 'autoStart':
                this.settings.autoStart = Boolean(arg);
                m.autoStart = this.settings.autoStart;
                this.saveSettings();
                break;
            case 'dungeonMode':
                this.settings.dungeonMode = Boolean(arg);
                m.setDungeonMode(this.settings.dungeonMode);
                this.saveSettings();
                break;
            case 'layout':
                // A window the player moved or resized: { id, rect: { x, y, w, h } }, in CSS px.
                if (arg && typeof arg === 'object' && ['fight', 'rotation', 'spells'].includes(arg.id)) {
                    const lay = (this.settings.layout = this.settings.layout || { rects: {} });
                    lay.rects = lay.rects || {};
                    const r = arg.rect;
                    if (r && typeof r === 'object') {
                        lay.rects[arg.id] = {
                            x: Math.round(Number(r.x) || 0),
                            y: Math.round(Number(r.y) || 0),
                            w: Math.round(Number(r.w) || 0),
                            h: Math.round(Number(r.h) || 0)
                        };
                    } else {
                        delete lay.rects[arg.id];
                    }
                    this.saveSettings();
                }
                break;
            case 'resetLayout':
                this.settings.layout = { rects: {} };
                this.saveSettings();
                break;
            case 'export':
                return this.exportResults(event);
            case 'copy':
                this.electron.clipboard.writeText(exporter.toSummary(m.report(), this.meta()));
                return { ok: true };
            case 'reveal':
                if (this.lastExport) this.electron.shell.showItemInFolder(this.lastExport);
                break;
            case 'rescan':
                if (this.scans) this.applyScan(this.scans.refresh());
                break;
            case 'scanFolder':
                if (this.scans) this.electron.shell.openPath(this.scans.primaryFolder());
                break;
            default:
                return { ok: false, error: 'unknown command' };
        }
        this.dirty = true;
        this.push();
        return { ok: true, view: this.view() };
    }

    meta() {
        const scan = this.scans ? this.scans.status() : null;
        return {
            source: SOURCE,
            character: this.character,
            className: this.className,
            scan: scan ? { file: scan.file, scannedAt: scan.scannedAt } : null
        };
    }

    async exportResults(event) {
        const { dialog, BrowserWindow } = this.electron;
        const win = event ? BrowserWindow.fromWebContents(event.sender) : null;
        const folder = path.join(this.app.getPath('documents'), 'Dungeon Blitz DPS');
        try {
            fs.mkdirSync(folder, { recursive: true });
        } catch (_e) {
            // the dialog still opens
        }
        const base = 'DPS ' + safeFileName(this.character) + ' ' + stamp(new Date());
        const result = await dialog.showSaveDialog(win, {
            title: 'Export DPS results',
            defaultPath: path.join(folder, base + '.json'),
            filters: [
                { name: 'Everything, GO-style JSON (dbb-dps v2)', extensions: ['json'] },
                { name: 'Spell table and rotation (CSV, for spreadsheets)', extensions: ['csv'] }
            ]
        });
        if (result.canceled || !result.filePath) {
            return { ok: false, canceled: true };
        }
        const report = this.meter.report();
        const meta = this.meta();
        const file = result.filePath;
        const body = /\.csv$/i.test(file) ? exporter.toCsv(report, meta) : JSON.stringify(exporter.toJson(report, meta), null, 2);
        fs.writeFileSync(file, body, 'utf8');
        this.lastExport = file;
        log('Exported ' + file);
        this.dirty = true;
        return { ok: true, file };
    }

    /* ---------- settings ---------- */

    settingsPath() {
        return path.join(this.app.getPath('userData'), 'dps-overlay.json');
    }

    loadSettings() {
        try {
            const s = JSON.parse(fs.readFileSync(this.settingsPath(), 'utf8'));
            if (s && typeof s === 'object') {
                this.settings = Object.assign(this.settings, s);
                delete this.settings.compact; // the old single movable card
            }
        } catch (_e) {
            // first run
        }
    }

    saveSettings() {
        try {
            fs.writeFileSync(this.settingsPath(), JSON.stringify(this.settings, null, 2));
        } catch (_e) {
            // not fatal
        }
    }
}

module.exports = { DpsOverlay, webHosts, findFreePorts, VERSION };
