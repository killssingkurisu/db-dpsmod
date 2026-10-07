'use strict';

/**
 * The launcher's own settings (launcher.json in its data folder): window placement, a Flash
 * plugin the player picked, and the game address. The meter keeps its settings separately
 * (dps-overlay.json).
 */

const fs = require('fs');
const path = require('path');

const DEFAULTS = {
    windowBounds: null, // { x, y, width, height } of the normal (not maximised) window
    maximized: true, // the first start fills the screen
    flashPath: '', // a pepflashplayer64.dll the player chose by hand
    gameUrl: '', // another game address, for testing servers; empty = the official one
    importedOfficial: false // the meter's settings were copied over from the official launcher once
};

class Settings {
    constructor(dir) {
        this.file = path.join(dir, 'launcher.json');
        this.data = Object.assign({}, DEFAULTS);
        try {
            const saved = JSON.parse(fs.readFileSync(this.file, 'utf8'));
            if (saved && typeof saved === 'object') Object.assign(this.data, saved);
        } catch (_e) {
            // first start
        }
    }

    get(key) {
        return this.data[key];
    }

    set(fields) {
        Object.assign(this.data, fields);
        try {
            fs.mkdirSync(path.dirname(this.file), { recursive: true });
            fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2));
        } catch (_e) {
            // not fatal: the next start uses the defaults
        }
    }
}

/**
 * Copies the meter's settings and spell-data cache from the Dungeon Blitz R launcher's data
 * folder (where the meter lived when it was a mod of that launcher) the first time this launcher
 * starts, so the windows open where the player left them. Never overwrites anything.
 * Returns the files copied.
 */
function importFromOfficial(userData, appData) {
    const from = path.join(appData, 'dungeon-blitz-r-launcher');
    const copied = [];
    for (const name of ['dps-overlay.json', 'dps-powers-cache.json']) {
        const src = path.join(from, name);
        const dst = path.join(userData, name);
        try {
            if (fs.existsSync(dst) || !fs.statSync(src).isFile()) continue;
            fs.mkdirSync(userData, { recursive: true });
            fs.copyFileSync(src, dst);
            copied.push(name);
        } catch (_e) {
            // not there
        }
    }
    return copied;
}

/** Keeps saved window bounds only if they still land on a screen the player has. */
function visibleBounds(bounds, displays) {
    if (!bounds || !Number.isFinite(bounds.width) || !Number.isFinite(bounds.height)) return null;
    const onScreen = (displays || []).some((d) => {
        const a = d.workArea || d.bounds;
        return bounds.x < a.x + a.width - 80 && bounds.x + bounds.width > a.x + 80 && bounds.y >= a.y - 10 && bounds.y < a.y + a.height - 60;
    });
    return onScreen ? bounds : { width: bounds.width, height: bounds.height };
}

module.exports = { Settings, DEFAULTS, importFromOfficial, visibleBounds };
