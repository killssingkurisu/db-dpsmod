'use strict';

/**
 * DB DPS Launcher: Dungeon Blitz R in its own window, with the DPS meter built in and updates
 * from this project's GitHub Releases.
 *
 * Start-up, in the order Electron needs it:
 *   before 'ready'  find the Flash plugin and put it on Chromium's command line; let the meter
 *                   map the game website onto its local proxy (src/dps/index.js);
 *   on 'ready'      open the game window, start the update checks.
 *
 * Command line:
 *   --smoke-test=<file.json>   start, load the game page, write what loaded to the file, quit
 *                              (used by the build to check the packaged launcher)
 * Environment:
 *   DBDPS_GAME_URL             open another game address (a test server)
 *   DUNGEON_BLITZ_DPS=0        start without the meter
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { app, BrowserWindow, ipcMain, shell, dialog, screen } = require('electron');

const { findFlash, describe } = require('./flash');
const { Settings, importFromOfficial, visibleBounds } = require('./settings');
const { createUpdater } = require('./updater');

const APP_ID = 'io.github.killssingkurisu.dbdps';
const OFFICIAL_GAME_URL = 'http://dungeonblitzr.theminesa.studio/';
const PROJECT_URL = 'https://github.com/killssingkurisu/db-dpsmod';
const BACKGROUND = '#484955'; // the game page's own grey
const TITLE = 'DB DPS Launcher';

const smokeArg = process.argv.find((a) => a.startsWith('--smoke-test='));
const smokeFile = smokeArg ? path.resolve(smokeArg.slice('--smoke-test='.length)) : '';
if (smokeFile) app.setPath('userData', path.join(os.tmpdir(), 'db-dps-launcher-smoke-' + process.pid));

/* ---------- log ---------- */

const logFile = path.join(app.getPath('userData'), 'launcher.log');
try {
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
    // One start's worth plus the one before it.
    if (fs.existsSync(logFile)) fs.renameSync(logFile, logFile.replace(/\.log$/, '.previous.log'));
} catch (_e) {
    // logging is best effort
}
function log(message) {
    const line = new Date().toISOString() + ' ' + message;
    console.log('[Launcher] ' + message);
    try {
        fs.appendFileSync(logFile, line + '\n');
    } catch (_e) {
        // best effort
    }
}

/* ---------- one launcher at a time ---------- */

if (!smokeFile && !app.requestSingleInstanceLock()) {
    app.quit();
} else {
    start();
}

function start() {
    app.setAppUserModelId(APP_ID);
    const settings = new Settings(app.getPath('userData'));
    const gameUrl = process.env.DBDPS_GAME_URL || settings.get('gameUrl') || OFFICIAL_GAME_URL;
    log(TITLE + ' ' + app.getVersion() + ' (Electron ' + process.versions.electron + ', ' + process.arch + '), game at ' + gameUrl);

    if (!smokeFile && !settings.get('importedOfficial')) {
        const copied = importFromOfficial(app.getPath('userData'), app.getPath('appData'));
        if (copied.length) log('Copied the meter settings from the Dungeon Blitz R launcher: ' + copied.join(', '));
        settings.set({ importedOfficial: true });
    }

    /* ---------- Flash (before 'ready': Chromium reads these switches once) ---------- */

    const flash = findFlash({ preferred: settings.get('flashPath'), resourcesPath: process.resourcesPath });
    for (const r of flash.rejected) log('Flash skipped: ' + r.path + ' ' + r.problem);
    if (flash.found) {
        app.commandLine.appendSwitch('ppapi-flash-path', flash.plugin.path);
        app.commandLine.appendSwitch('ppapi-flash-version', flash.plugin.version);
        log('Flash ' + flash.plugin.version + ' (' + flash.plugin.source + '): ' + flash.plugin.path);
    } else {
        log('No usable Flash plugin found');
    }

    /* ---------- the meter (before 'ready': it maps the game website onto its proxy) ---------- */

    let overlay = null;
    try {
        const { DpsOverlay } = require('../src/dps');
        overlay = new DpsOverlay({ gameUrls: [gameUrl] });
        overlay.prepare();
    } catch (err) {
        overlay = null;
        log('The meter is off: ' + ((err && err.stack) || err));
    }

    /* ---------- updates ---------- */

    let updater;
    {
        const enabled = app.isPackaged && !smokeFile && process.env.DBDPS_NO_UPDATES !== '1';
        let autoUpdater = null;
        if (enabled) {
            try {
                autoUpdater = require('electron-updater').autoUpdater;
                autoUpdater.logger = { info: (m) => log('[update] ' + m), warn: (m) => log('[update] ' + m), error: (m) => log('[update] ' + m), debug() {} };
            } catch (err) {
                log('Updates unavailable: ' + err.message);
            }
        }
        updater = createUpdater({
            autoUpdater,
            app,
            log,
            enabled: Boolean(autoUpdater),
            disabledReason: smokeFile ? 'Not during a test run.' : app.isPackaged ? 'Updates are turned off.' : 'Updates run in the installed launcher, not from source.'
        });
    }

    /* ---------- the window ---------- */

    let win = null;
    let page = 'game';

    function uiState() {
        return {
            version: app.getVersion(),
            update: updater.summary(),
            page,
            gameUrl,
            flash: flash.found ? { version: flash.plugin.version, source: flash.plugin.source, path: flash.plugin.path } : null,
            flashRejected: flash.rejected.map((r) => ({ path: r.path, problem: r.problem })),
            fullScreen: Boolean(win && !win.isDestroyed() && win.isFullScreen())
        };
    }

    function pushState() {
        if (win && !win.isDestroyed()) win.webContents.send('launcher:state', uiState());
    }
    updater.onChange(pushState);

    function showPage(name, query) {
        page = name;
        win.loadFile(path.join(__dirname, 'ui', name + '.html'), { query: query || {} });
    }

    function openGame() {
        if (!flash.found) {
            showPage('noflash');
            return;
        }
        page = 'game';
        win.loadURL(gameUrl);
    }

    function originOf(url) {
        try {
            return new URL(url).origin;
        } catch (_e) {
            return '';
        }
    }

    function createWindow() {
        const saved = visibleBounds(settings.get('windowBounds'), screen.getAllDisplays());
        win = new BrowserWindow({
            width: (saved && saved.width) || 1280,
            height: (saved && saved.height) || 820,
            x: saved && Number.isFinite(saved.x) ? saved.x : undefined,
            y: saved && Number.isFinite(saved.y) ? saved.y : undefined,
            minWidth: 800,
            minHeight: 560,
            backgroundColor: BACKGROUND,
            title: TITLE,
            show: false,
            icon: path.join(__dirname, 'icon.png'),
            webPreferences: {
                plugins: true,
                contextIsolation: true,
                nodeIntegration: false,
                webviewTag: false,
                preload: path.join(__dirname, 'ui', 'preload.js')
            }
        });
        win.setMenu(null);
        if (settings.get('maximized') && !smokeFile) win.maximize();
        win.once('ready-to-show', () => win.show());
        win.on('page-title-updated', (e) => e.preventDefault());

        const wc = win.webContents;
        const gameOrigin = originOf(gameUrl);
        // The game stays in this window; any other link opens in the player's browser.
        wc.on('will-navigate', (e, url) => {
            if (url.startsWith('file:') || originOf(url) === gameOrigin) return;
            e.preventDefault();
            if (/^https?:/i.test(url)) shell.openExternal(url);
        });
        wc.on('new-window', (e, url) => {
            e.preventDefault();
            if (/^https?:/i.test(url)) shell.openExternal(url);
        });
        wc.on('did-fail-load', (_e, code, description, url, isMainFrame) => {
            if (!isMainFrame || code === -3 || page !== 'game') return; // -3: replaced by another load
            log('The game page did not load: ' + description + ' (' + code + ') ' + url);
            showPage('offline', { error: description + ' (' + code + ')', url: url || gameUrl });
        });
        wc.on('did-finish-load', pushState);
        wc.on('before-input-event', (e, input) => {
            if (input.type !== 'keyDown') return;
            const key = String(input.key || '');
            if (key === 'F11') {
                win.setFullScreen(!win.isFullScreen());
                e.preventDefault();
            } else if (key === 'F5' || (input.control && !input.shift && key.toLowerCase() === 'r')) {
                if (page === 'game') wc.reload();
                else openGame();
                e.preventDefault();
            } else if (input.control && input.shift && key.toLowerCase() === 'i') {
                wc.toggleDevTools();
                e.preventDefault();
            }
        });
        win.on('enter-full-screen', pushState);
        win.on('leave-full-screen', pushState);
        win.on('close', () => {
            if (smokeFile) return;
            const fields = { maximized: win.isMaximized() };
            if (!win.isFullScreen() && !win.isMinimized()) fields.windowBounds = win.getNormalBounds();
            else fields.windowBounds = settings.get('windowBounds');
            settings.set(fields);
        });
        win.on('closed', () => {
            win = null;
        });
        openGame();
    }

    /* ---------- commands from the launcher's corner menu and its pages ---------- */

    ipcMain.handle('launcher:hello', () => uiState());
    ipcMain.handle('launcher:cmd', async (event, cmd) => {
        if (!win || event.sender !== win.webContents) return { ok: false };
        switch (cmd) {
            case 'checkUpdates':
                await updater.check(true);
                break;
            case 'installUpdate':
                return { ok: updater.install() };
            case 'reload':
                if (page === 'game') win.webContents.reload();
                else openGame();
                break;
            case 'retry':
                openGame();
                break;
            case 'fullscreen':
                win.setFullScreen(!win.isFullScreen());
                break;
            case 'openLogs':
                shell.openPath(app.getPath('userData'));
                break;
            case 'openExports': {
                const dir = path.join(app.getPath('documents'), 'Dungeon Blitz DPS');
                try {
                    fs.mkdirSync(dir, { recursive: true });
                } catch (_e) {
                    // opens what's there
                }
                shell.openPath(dir);
                break;
            }
            case 'openProject':
                shell.openExternal(PROJECT_URL + '/releases');
                break;
            case 'chooseFlash':
                return chooseFlash();
            default:
                return { ok: false, error: 'unknown command' };
        }
        pushState();
        return { ok: true, state: uiState() };
    });

    async function chooseFlash() {
        const r = await dialog.showOpenDialog(win, {
            title: 'Choose the Flash plugin (pepflashplayer64.dll)',
            properties: ['openFile'],
            filters: [{ name: 'Pepper Flash plugin', extensions: ['dll'] }]
        });
        if (r.canceled || !r.filePaths[0]) return { ok: false, canceled: true };
        const d = describe(r.filePaths[0], 'your choice');
        if (!d.usable) return { ok: false, error: 'That file ' + d.problem + '.' };
        settings.set({ flashPath: d.path });
        log('Flash chosen by hand: ' + d.path + ' (' + d.version + '); restarting');
        app.relaunch();
        app.exit(0);
        return { ok: true };
    }

    /* ---------- smoke test (the build runs the packaged launcher once) ---------- */

    async function smokeTest() {
        const result = { version: app.getVersion(), electron: process.versions.electron, flash: flash.found ? flash.plugin : null, flashRejected: flash.rejected };
        const finish = (code) => {
            try {
                fs.writeFileSync(smokeFile, JSON.stringify(result, null, 2));
            } catch (_e) {
                // the exit code still says it
            }
            app.exit(code);
        };
        setTimeout(() => {
            result.timedOut = true;
            finish(1);
        }, 120000).unref();
        try {
            await new Promise((resolve) => win.webContents.once('did-finish-load', resolve));
            result.page = page;
            result.url = win.webContents.getURL();
            result.plugins = await win.webContents.executeJavaScript('Array.from(navigator.plugins).map((p) => p.name + " " + (p.version || p.description || ""))', true);
            result.overlayLoaded = await win.webContents.executeJavaScript('Boolean(document.getElementById("dbdps"))', true).catch(() => false);
            result.launcherUi = await win.webContents.executeJavaScript('Boolean(document.querySelector("db-launcher-ui"))', true).catch(() => false);
            // The page hands DungeonBlitz.swf to Flash only once the plugin is running.
            const until = Date.now() + 60000;
            while (Date.now() < until && overlay && overlay.proxy && !overlay.proxy.swf) await new Promise((r) => setTimeout(r, 500));
            await new Promise((r) => setTimeout(r, 5000));
            if (overlay) {
                const swf = overlay.proxy && overlay.proxy.swf;
                result.meter = {
                    proxyListening: Boolean(overlay.proxy && overlay.proxy.listening),
                    swfServed: Boolean(swf),
                    swfPatched: Boolean(swf && swf.ok),
                    swfReport: swf ? swf.report : null,
                    relays: overlay.hub ? overlay.hub.all.map((r) => ({ label: r.label, port: r.listenPort, connections: r.connections })) : []
                };
            }
            const flashListed = (result.plugins || []).some((p) => /shockwave flash/i.test(p));
            result.ok = Boolean(flash.found && flashListed && result.meter && result.meter.swfPatched);
            finish(result.ok ? 0 : 1);
        } catch (err) {
            result.error = String((err && err.stack) || err);
            finish(1);
        }
    }

    /* ---------- app events ---------- */

    app.on('second-instance', () => {
        if (!win) return;
        if (win.isMinimized()) win.restore();
        win.focus();
    });
    app.on('window-all-closed', () => app.quit());

    app.whenReady().then(() => {
        createWindow();
        if (smokeFile) smokeTest();
        else updater.start();
    });
}
