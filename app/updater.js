'use strict';

/**
 * In-app updates from this project's GitHub Releases (electron-updater, GitHub provider; the
 * feed is named in package.json "build.publish" and baked into the installed app as
 * resources\app-update.yml).
 *
 * What a player sees: a few seconds after start, and every hour after that, the launcher looks
 * for a newer release. A newer one downloads in the background, then the launcher says it's
 * ready, in its corner menu, with a button to restart and install. Nothing restarts by itself,
 * because the game may be running; if the player never clicks, the update installs when they
 * quit the launcher.
 *
 * electron-updater is passed in, so tests drive this with a fake (test/launcher.js).
 */

const START_DELAY_MS = 8000;
const INTERVAL_MS = 60 * 60 * 1000;

/** Release notes as short plain text (GitHub's feed gives HTML, sometimes one block per version). */
function plainNotes(notes) {
    let text = '';
    if (Array.isArray(notes)) text = notes.map((n) => (n && n.note) || '').join('\n');
    else text = String(notes || '');
    text = text
        .replace(/<\/(p|li|h\d|div)>|<br\s*\/?>/gi, '\n')
        .replace(/<li[^>]*>/gi, '- ')
        .replace(/<[^>]+>/g, '')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/\n{3,}/g, '\n\n')
        .trim();
    return text.length > 700 ? text.slice(0, 697).trimEnd() + '…' : text;
}

function createUpdater({ autoUpdater, app, log = () => {}, enabled = true, disabledReason = '' }) {
    const state = {
        // idle, checking, downloading, ready, current, error, off
        state: enabled ? 'idle' : 'off',
        current: app && app.getVersion ? app.getVersion() : '',
        version: '',
        notes: '',
        percent: 0,
        error: '',
        offReason: enabled ? '' : disabledReason || 'Updates only run in the installed launcher.',
        checkedAt: 0,
        manual: false
    };
    const listeners = [];
    const changed = () => {
        for (const fn of listeners) {
            try {
                fn(summary());
            } catch (_e) {
                // a listener's problem
            }
        }
    };
    const set = (fields) => {
        Object.assign(state, fields);
        changed();
    };
    function summary() {
        return Object.assign({}, state);
    }

    let timer = null;
    let startTimer = null;

    if (enabled) {
        autoUpdater.autoDownload = true;
        autoUpdater.autoInstallOnAppQuit = true;
        autoUpdater.allowPrerelease = false;
        autoUpdater.allowDowngrade = false;

        autoUpdater.on('checking-for-update', () => {
            if (state.state !== 'ready' && state.state !== 'downloading') set({ state: 'checking', error: '' });
        });
        autoUpdater.on('update-available', (info) => {
            log('Update ' + (info && info.version) + ' found, downloading');
            set({ state: 'downloading', version: String((info && info.version) || ''), notes: plainNotes(info && info.releaseNotes), percent: 0, error: '' });
        });
        autoUpdater.on('update-not-available', () => {
            if (state.state === 'ready') return;
            set({ state: 'current', version: '', percent: 0, error: '', checkedAt: Date.now() });
        });
        autoUpdater.on('download-progress', (p) => {
            set({ state: 'downloading', percent: Math.max(0, Math.min(100, Math.round((p && p.percent) || 0))) });
        });
        autoUpdater.on('update-downloaded', (info) => {
            log('Update ' + (info && info.version) + ' downloaded, ready to install');
            set({
                state: 'ready',
                version: String((info && info.version) || state.version),
                notes: plainNotes(info && info.releaseNotes) || state.notes,
                percent: 100,
                error: '',
                checkedAt: Date.now()
            });
        });
        autoUpdater.on('error', (err) => {
            const message = String((err && err.message) || err).split('\n')[0];
            log('Update check failed: ' + message);
            // A download that failed after the update was found is retried on the next check; one
            // already downloaded stays ready.
            if (state.state === 'ready') return;
            set({ state: 'error', error: message, checkedAt: Date.now() });
        });
    }

    function check(manual) {
        if (!enabled) return Promise.resolve(summary());
        if (state.state === 'downloading') return Promise.resolve(summary());
        state.manual = Boolean(manual);
        let result;
        try {
            result = autoUpdater.checkForUpdates();
        } catch (err) {
            set({ state: 'error', error: String((err && err.message) || err) });
            return Promise.resolve(summary());
        }
        return Promise.resolve(result)
            .catch(() => null)
            .then(() => summary());
    }

    return {
        summary,
        onChange(fn) {
            listeners.push(fn);
        },
        start() {
            if (!enabled || timer) return;
            startTimer = setTimeout(() => check(false), START_DELAY_MS);
            timer = setInterval(() => check(false), INTERVAL_MS);
            if (startTimer.unref) startTimer.unref();
            if (timer.unref) timer.unref();
        },
        stop() {
            clearTimeout(startTimer);
            clearInterval(timer);
            timer = null;
        },
        check,
        /** Restarts into the installer. Only when an update is ready, and only on the player's click. */
        install() {
            if (state.state !== 'ready') return false;
            log('Restarting to install ' + state.version);
            // Silent install (no installer window), then start the launcher again.
            autoUpdater.quitAndInstall(true, true);
            return true;
        }
    };
}

module.exports = { createUpdater, plainNotes, START_DELAY_MS, INTERVAL_MS };
