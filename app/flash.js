'use strict';

/**
 * Finds the Pepper Flash plugin the game runs in.
 *
 * Electron 11 (Chromium 87) is the last Electron that can host a PPAPI plugin, which is why the
 * launcher is built on it. The plugin is loaded into the launcher's own process, so it has to be
 * a 64-bit build for this 64-bit launcher, and it has to be older than 32.0.0.371: Adobe built
 * an end-of-life switch into 32.0.0.371 and later that stops Flash from running after
 * 12 January 2021.
 *
 * Where it looks, in order:
 *   1. a file the player picked (settings.flashPath);
 *   2. the copy installed with the launcher (resources\vendor\flash\win32, see
 *      tools/fetch-flash.js);
 *   3. the official Dungeon Blitz R launcher's copy, if that is installed;
 *   4. a system-wide Flash install (Windows\System32\Macromed\Flash) and the copies Chrome,
 *      Edge and Opera used to keep.
 */

const fs = require('fs');
const path = require('path');

/** The first Flash build with Adobe's end-of-life switch. */
const KILL_SWITCH_FIRST = [32, 0, 0, 371];
const PLUGIN_NAME = /^pepflashplayer(64)?(_[\d_]+)?\.dll$/i;

function isFile(p) {
    try {
        return fs.statSync(p).isFile();
    } catch (_e) {
        return false;
    }
}

function isDir(p) {
    try {
        return fs.statSync(p).isDirectory();
    } catch (_e) {
        return false;
    }
}

/**
 * Reads a Windows DLL's machine type and file version from its bytes: { arch, version }.
 * arch is 'x64', 'ia32', 'arm64' or ''; version is "32.0.0.363" or '' when there is none.
 */
function readPe(buf) {
    const out = { arch: '', version: '' };
    if (!buf || buf.length < 64 || buf.readUInt16LE(0) !== 0x5a4d) return out; // "MZ"
    const pe = buf.readUInt32LE(0x3c);
    if (pe + 6 <= buf.length && buf.readUInt32LE(pe) === 0x00004550) {
        out.arch = { 0x8664: 'x64', 0x014c: 'ia32', 0xaa64: 'arm64' }[buf.readUInt16LE(pe + 4)] || '';
    }
    // VS_FIXEDFILEINFO starts with the signature 0xFEEF04BD and the structure version 1.0
    // (0x00010000); the file version follows. Checking both rules out the same four bytes
    // turning up in code.
    const sig = Buffer.from([0xbd, 0x04, 0xef, 0xfe]);
    for (let at = buf.lastIndexOf(sig); at >= 0; at = at > 0 ? buf.lastIndexOf(sig, at - 1) : -1) {
        if (at + 16 <= buf.length && buf.readUInt32LE(at + 4) === 0x00010000) {
            const ms = buf.readUInt32LE(at + 8);
            const ls = buf.readUInt32LE(at + 12);
            out.version = [ms >>> 16, ms & 0xffff, ls >>> 16, ls & 0xffff].join('.');
            break;
        }
    }
    return out;
}

function parseVersion(v) {
    const parts = String(v || '')
        .split(/[.,_]/)
        .map((x) => parseInt(x, 10));
    while (parts.length < 4) parts.push(0);
    return parts.slice(0, 4).map((x) => (Number.isFinite(x) ? x : 0));
}

function hasKillSwitch(version) {
    const v = parseVersion(version);
    for (let i = 0; i < 4; i++) {
        if (v[i] !== KILL_SWITCH_FIRST[i]) return v[i] > KILL_SWITCH_FIRST[i];
    }
    return true;
}

/** What the launcher knows about one plugin file. */
function describe(file, source) {
    let info = { arch: '', version: '' };
    try {
        info = readPe(fs.readFileSync(file));
    } catch (_e) {
        // unreadable: reported as unusable below
    }
    const version = info.version || (/(\d+)[._](\d+)[._](\d+)[._](\d+)/.exec(path.basename(file)) || []).slice(1, 5).join('.');
    const problems = [];
    if (!info.arch) problems.push("isn't a Windows DLL");
    else if (info.arch !== process.arch) problems.push('is a ' + info.arch + ' build; this launcher needs ' + process.arch);
    if (version && hasKillSwitch(version)) problems.push('is Flash ' + version + ', which has Adobe’s end-of-life switch (use 32.0.0.363 or older)');
    return { path: file, version: version || '32.0.0.363', source, arch: info.arch, usable: problems.length === 0, problem: problems.join(' and ') };
}

/** The plugin files in a folder (and one level of version folders under it, as Chrome kept them). */
function pluginsIn(dir, depth) {
    if (!isDir(dir)) return [];
    let names = [];
    try {
        names = fs.readdirSync(dir).sort().reverse();
    } catch (_e) {
        return [];
    }
    const out = names.filter((n) => PLUGIN_NAME.test(n) && isFile(path.join(dir, n))).map((n) => path.join(dir, n));
    // 64-bit names first: a folder can hold both builds.
    out.sort((a, b) => Number(/64/.test(path.basename(b))) - Number(/64/.test(path.basename(a))));
    if ((depth || 0) < 1) {
        for (const n of names) {
            if (isDir(path.join(dir, n))) out.push(...pluginsIn(path.join(dir, n), (depth || 0) + 1));
        }
    }
    return out;
}

/**
 * Folders to look in, in order, as [dir, source]. `fromSource` adds vendor\flash\win32 in the
 * project folder, where tools/fetch-flash.js puts the plugin for running the launcher from source.
 */
function searchDirs(env, resourcesPath, fromSource) {
    const e = env || process.env;
    const out = [];
    if (resourcesPath) out.push([path.join(resourcesPath, 'vendor', 'flash', 'win32'), 'bundled']);
    if (fromSource !== false) out.push([path.join(__dirname, '..', 'vendor', 'flash', 'win32'), 'bundled']);
    const local = e.LOCALAPPDATA || '';
    if (local) out.push([path.join(local, 'Programs', 'Dungeon Blitz R', 'resources', 'vendor', 'flash', 'win32'), 'the Dungeon Blitz R launcher']);
    const sys = e.SystemRoot || 'C:\\Windows';
    out.push([path.join(sys, 'System32', 'Macromed', 'Flash'), 'Windows']);
    if (local) {
        out.push([path.join(local, 'Google', 'Chrome', 'User Data', 'PepperFlash'), 'Chrome']);
        out.push([path.join(local, 'Microsoft', 'Edge', 'User Data', 'PepperFlash'), 'Edge']);
    }
    const pf86 = e['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
    out.push([path.join(pf86, 'Opera', 'PepperFlash'), 'Opera']);
    return out;
}

/**
 * The plugin to load: { found, plugin, rejected[] }. `plugin` is the first usable one;
 * `rejected` lists the ones skipped and why, for the "Flash is missing" page.
 */
function findFlash({ preferred, env, resourcesPath, fromSource } = {}) {
    const rejected = [];
    const seen = new Set();
    const consider = (file, source) => {
        const key = path.resolve(file).toLowerCase();
        if (seen.has(key)) return null;
        seen.add(key);
        const d = describe(file, source);
        if (d.usable) return d;
        rejected.push(d);
        return null;
    };
    if (preferred) {
        const files = isFile(preferred) ? [preferred] : pluginsIn(preferred);
        if (!files.length) rejected.push({ path: preferred, source: 'your choice', usable: false, problem: 'is no longer there' });
        for (const f of files) {
            const d = consider(f, 'your choice');
            if (d) return { found: true, plugin: d, rejected };
        }
    }
    for (const [dir, source] of searchDirs(env, resourcesPath, fromSource)) {
        for (const f of pluginsIn(dir)) {
            const d = consider(f, source);
            if (d) return { found: true, plugin: d, rejected };
        }
    }
    return { found: false, plugin: null, rejected };
}

module.exports = { findFlash, describe, readPe, hasKillSwitch, parseVersion, searchDirs, pluginsIn, KILL_SWITCH_FIRST };
