'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');

/**
 * Finds the newest spell scan DB Inventory Scanner saved for a character.
 *
 * The scanner saves to Documents\DB Inventory Scanner unless its settings
 * (%APPDATA%\DbScanner\settings.json, "folder") name another folder. Spell data is in a
 * "spells" object, either in a full inventory scan ("dbb-inventory") or in a spells-only
 * scan ("dbb-spells"); see FORMAT.md in the scanner repo.
 */

function documentsDir() {
    if (process.platform === 'win32') {
        const profile = process.env.USERPROFILE || os.homedir();
        return path.join(profile, 'Documents');
    }
    return path.join(os.homedir(), 'Documents');
}

function scannerFolders(electronDocuments) {
    const folders = [];
    try {
        const settingsPath = path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'DbScanner', 'settings.json');
        const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
        if (settings && typeof settings.folder === 'string' && settings.folder) {
            folders.push(settings.folder);
        }
    } catch (_e) {
        // No settings yet: the default folder.
    }
    for (const docs of [electronDocuments, documentsDir()]) {
        if (docs) {
            const f = path.join(docs, 'DB Inventory Scanner');
            if (!folders.includes(f)) folders.push(f);
        }
    }
    return folders;
}

function readScan(file) {
    try {
        const raw = fs.readFileSync(file, 'utf8').replace(/^﻿/, '');
        const json = JSON.parse(raw);
        if (!json || (json.format !== 'dbb-inventory' && json.format !== 'dbb-spells')) {
            return null;
        }
        const spells = json.spells;
        if (!spells || (!Array.isArray(spells.abilities) && !Array.isArray(spells.hotbar))) {
            return null;
        }
        return {
            file,
            scannedAt: String(spells.scannedAt || json.scannedAt || ''),
            character: (json.character && String(json.character.name || '')) || '',
            className: (json.character && String(json.character.class || '')) || '',
            abilities: Array.isArray(spells.abilities) ? spells.abilities : [],
            hotbar: Array.isArray(spells.hotbar) ? spells.hotbar : []
        };
    } catch (_e) {
        return null;
    }
}

class SpellScanStore extends EventEmitter {
    constructor({ documents } = {}) {
        super();
        this.folders = scannerFolders(documents);
        this.watchers = [];
        this.character = '';
        this.current = null;
        this.timer = null;
    }

    setCharacter(name) {
        const next = String(name || '');
        if (next.toLowerCase() === this.character.toLowerCase()) {
            return;
        }
        this.character = next;
        this.refresh();
    }

    /** Newest scan for the current character (or the newest of all when none is known yet). */
    refresh() {
        const candidates = [];
        for (const folder of this.folders) {
            let names = [];
            try {
                names = fs.readdirSync(folder).filter((n) => n.toLowerCase().endsWith('.json'));
            } catch (_e) {
                continue;
            }
            for (const n of names) {
                const file = path.join(folder, n);
                let mtime = 0;
                try {
                    mtime = fs.statSync(file).mtimeMs;
                } catch (_e) {
                    continue;
                }
                candidates.push({ file, mtime });
            }
        }
        candidates.sort((a, b) => b.mtime - a.mtime);
        let best = null;
        for (const c of candidates.slice(0, 200)) {
            const scan = readScan(c.file);
            if (!scan) continue;
            if (this.character && scan.character && scan.character.toLowerCase() !== this.character.toLowerCase()) {
                continue;
            }
            best = scan;
            break;
        }
        const changed = (best && best.file) !== (this.current && this.current.file) || (best && this.current && best.scannedAt !== this.current.scannedAt);
        this.current = best;
        if (changed) {
            this.emit('change', best);
        }
        return best;
    }

    watch() {
        for (const folder of this.folders) {
            try {
                const w = fs.watch(folder, () => {
                    clearTimeout(this.timer);
                    this.timer = setTimeout(() => this.refresh(), 800);
                });
                w.on('error', () => {});
                this.watchers.push(w);
            } catch (_e) {
                // The folder doesn't exist until the scanner saves something.
            }
        }
    }

    close() {
        for (const w of this.watchers) {
            try {
                w.close();
            } catch (_e) {
                // already closed
            }
        }
        this.watchers = [];
    }

    status() {
        return this.current
            ? { file: path.basename(this.current.file), scannedAt: this.current.scannedAt, character: this.current.character, spells: this.current.abilities.length, hotbar: this.current.hotbar.length }
            : null;
    }

    primaryFolder() {
        return this.folders[0];
    }
}

module.exports = { SpellScanStore, readScan, scannerFolders };
