'use strict';

/**
 * Checks for the launcher around the meter, under plain Node (12+, the version inside
 * Electron 11): finding Flash, the update states the corner menu shows, settings, and the
 * package config the in-app updates depend on.
 *
 *   node test/launcher.js
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');

const flash = require('../app/flash');
const { createUpdater, plainNotes } = require('../app/updater');
const { Settings, importFromOfficial, visibleBounds } = require('../app/settings');
const { webHosts } = (() => {
    // index.js needs Electron only once the meter starts; webHosts is plain.
    const Module = require('module');
    const load = Module._load;
    Module._load = function (req) {
        if (req === 'electron') return {};
        return load.apply(this, arguments);
    };
    try {
        return require('../src/dps/index.js');
    } finally {
        Module._load = load;
    }
})();

let passed = 0;
const failures = [];
async function check(name, fn) {
    try {
        await fn();
        passed += 1;
        console.log('  ok   ' + name);
    } catch (err) {
        failures.push(name);
        console.log('  FAIL ' + name + '\n       ' + String((err && err.stack) || err).split('\n').slice(0, 4).join('\n       '));
    }
}

const made = [];
function tmp(prefix) {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    made.push(d);
    return d;
}

/** A stand-in DLL: an MZ/PE header with a machine type, and a VS_FIXEDFILEINFO with a version. */
function fakeDll(machine, version) {
    const buf = Buffer.alloc(4096);
    buf.write('MZ', 0, 'latin1');
    buf.writeUInt32LE(0x80, 0x3c);
    buf.writeUInt32LE(0x00004550, 0x80);
    buf.writeUInt16LE(machine, 0x84);
    // Some bytes that look like the signature but aren't the structure (wrong structure version).
    buf.writeUInt32LE(0xfeef04bd, 0x400);
    buf.writeUInt32LE(0x12345678, 0x404);
    if (version) {
        const [a, b, c, d] = version.split('.').map(Number);
        const at = 0xc00;
        buf.writeUInt32LE(0xfeef04bd, at);
        buf.writeUInt32LE(0x00010000, at + 4);
        buf.writeUInt32LE(((a << 16) | b) >>> 0, at + 8);
        buf.writeUInt32LE(((c << 16) | d) >>> 0, at + 12);
    }
    return buf;
}

async function main() {
    console.log('Flash');
    await check('reads the machine type and file version of a DLL', () => {
        assert.deepStrictEqual(flash.readPe(fakeDll(0x8664, '32.0.0.363')), { arch: 'x64', version: '32.0.0.363' });
        assert.deepStrictEqual(flash.readPe(fakeDll(0x014c, '32.0.0.465')), { arch: 'ia32', version: '32.0.0.465' });
        assert.deepStrictEqual(flash.readPe(Buffer.from('not a dll at all, just text, long enough to have a header....')), { arch: '', version: '' });
    });

    await check("Adobe's end-of-life switch: 32.0.0.371 and later are refused", () => {
        assert.strictEqual(flash.hasKillSwitch('32.0.0.363'), false);
        assert.strictEqual(flash.hasKillSwitch('32.0.0.344'), false);
        assert.strictEqual(flash.hasKillSwitch('31.0.0.153'), false);
        assert.strictEqual(flash.hasKillSwitch('32.0.0.371'), true);
        assert.strictEqual(flash.hasKillSwitch('32.0.0.465'), true);
        assert.strictEqual(flash.hasKillSwitch('33.0.0.0'), true);
    });

    await check('finds the bundled plugin first, and skips unusable ones with a reason', () => {
        const res = tmp('dbl-res-');
        const local = tmp('dbl-local-');
        const sys = tmp('dbl-sys-');
        const bundled = path.join(res, 'vendor', 'flash', 'win32');
        const official = path.join(local, 'Programs', 'Dungeon Blitz R', 'resources', 'vendor', 'flash', 'win32');
        const macromed = path.join(sys, 'System32', 'Macromed', 'Flash');
        for (const d of [bundled, official, macromed]) fs.mkdirSync(d, { recursive: true });
        const env = { LOCALAPPDATA: local, SystemRoot: sys };
        const arch = { x64: 0x8664, ia32: 0x014c, arm64: 0xaa64 }[process.arch] || 0x8664;
        const other = arch === 0x8664 ? 0x014c : 0x8664;

        // Only a system copy with the kill switch: nothing usable, and it says why.
        fs.writeFileSync(path.join(macromed, 'pepflashplayer64_32_0_0_465.dll'), fakeDll(arch, '32.0.0.465'));
        let r = flash.findFlash({ env, resourcesPath: res, fromSource: false });
        assert.strictEqual(r.found, false);
        assert.ok(/end-of-life/.test(r.rejected[0].problem), r.rejected[0].problem);

        // The official launcher's copy is used when the bundled one is missing.
        fs.writeFileSync(path.join(official, 'pepflashplayer64.dll'), fakeDll(arch, '32.0.0.363'));
        r = flash.findFlash({ env, resourcesPath: res, fromSource: false });
        assert.strictEqual(r.found, true);
        assert.strictEqual(r.plugin.source, 'the Dungeon Blitz R launcher');

        // The bundled copy wins; a wrong-architecture one beside it is skipped.
        fs.writeFileSync(path.join(bundled, 'pepflashplayer.dll'), fakeDll(other, '32.0.0.363'));
        fs.writeFileSync(path.join(bundled, 'pepflashplayer64.dll'), fakeDll(arch, '32.0.0.363'));
        r = flash.findFlash({ env, resourcesPath: res, fromSource: false });
        assert.strictEqual(r.plugin.source, 'bundled');
        assert.strictEqual(r.plugin.path, path.join(bundled, 'pepflashplayer64.dll'));
        assert.strictEqual(r.plugin.version, '32.0.0.363');

        // A file the player chose comes before all of them; one that's gone is reported.
        const chosen = path.join(tmp('dbl-chosen-'), 'pepflashplayer64_32_0_0_344.dll');
        fs.writeFileSync(chosen, fakeDll(arch, '32.0.0.344'));
        r = flash.findFlash({ env, resourcesPath: res, fromSource: false, preferred: chosen });
        assert.strictEqual(r.plugin.source, 'your choice');
        assert.strictEqual(r.plugin.version, '32.0.0.344');
        r = flash.findFlash({ env, resourcesPath: res, fromSource: false, preferred: chosen + '.gone' });
        assert.strictEqual(r.plugin.source, 'bundled');
        assert.ok(r.rejected.some((x) => /no longer there/.test(x.problem)));
    });

    const realDll = path.join(__dirname, '..', 'vendor', 'flash', 'win32', 'pepflashplayer64.dll');
    if (fs.existsSync(realDll)) {
        await check('the bundled plugin is Flash 32.0.0.363, 64-bit', () => {
            const d = flash.describe(realDll, 'bundled');
            assert.strictEqual(d.version, '32.0.0.363');
            assert.strictEqual(d.arch, 'x64');
        });
    }

    console.log('Updates');
    const fakeUpdater = () => {
        const u = new EventEmitter();
        u.checks = 0;
        u.installs = [];
        u.checkForUpdates = () => {
            u.checks += 1;
            return Promise.resolve(null);
        };
        u.quitAndInstall = (...args) => u.installs.push(args);
        return u;
    };
    const fakeApp = { getVersion: () => '1.6.0' };

    await check('found, downloading, ready, then installed on the click', async () => {
        const au = fakeUpdater();
        const up = createUpdater({ autoUpdater: au, app: fakeApp });
        const seen = [];
        up.onChange((s) => seen.push(s.state));
        assert.strictEqual(au.autoDownload, true);
        assert.strictEqual(au.autoInstallOnAppQuit, true, 'a skipped restart still installs on quit');
        assert.strictEqual(up.install(), false, 'nothing to install yet');
        await up.check(true);
        assert.strictEqual(au.checks, 1);
        au.emit('checking-for-update');
        au.emit('update-available', { version: '1.6.1', releaseNotes: '<p>Fixes the <b>rotation</b> line.</p>' });
        au.emit('download-progress', { percent: 41.6 });
        assert.strictEqual(up.summary().percent, 42);
        assert.strictEqual(up.summary().state, 'downloading');
        au.emit('update-downloaded', { version: '1.6.1' });
        const s = up.summary();
        assert.strictEqual(s.state, 'ready');
        assert.strictEqual(s.version, '1.6.1');
        assert.strictEqual(s.current, '1.6.0');
        assert.strictEqual(s.notes, 'Fixes the rotation line.');
        // A later check that finds nothing newer, or fails, doesn't hide the ready update.
        au.emit('update-not-available');
        au.emit('error', new Error('offline'));
        assert.strictEqual(up.summary().state, 'ready');
        assert.strictEqual(up.install(), true);
        assert.deepStrictEqual(au.installs, [[true, true]], 'silent install, then start again');
        assert.deepStrictEqual(seen.slice(0, 4), ['checking', 'downloading', 'downloading', 'ready']);
    });

    await check('up to date, and an error the menu can show', async () => {
        const au = fakeUpdater();
        const up = createUpdater({ autoUpdater: au, app: fakeApp });
        au.emit('checking-for-update');
        assert.strictEqual(up.summary().state, 'checking');
        au.emit('update-not-available');
        assert.strictEqual(up.summary().state, 'current');
        assert.ok(up.summary().checkedAt > 0);
        au.emit('error', new Error('net::ERR_INTERNET_DISCONNECTED\n    at stack'));
        assert.strictEqual(up.summary().state, 'error');
        assert.strictEqual(up.summary().error, 'net::ERR_INTERNET_DISCONNECTED');
    });

    await check('off when not installed, without touching the updater', async () => {
        const up = createUpdater({ autoUpdater: null, app: fakeApp, enabled: false, disabledReason: 'Updates run in the installed launcher, not from source.' });
        assert.strictEqual(up.summary().state, 'off');
        assert.ok(/installed launcher/.test(up.summary().offReason));
        await up.check(true);
        up.start();
        assert.strictEqual(up.install(), false);
    });

    await check('release notes become short plain text', () => {
        assert.strictEqual(plainNotes('<h2>1.6.1</h2><ul><li>One</li><li>Two &amp; three</li></ul>'), '1.6.1\n- One\n- Two & three');
        assert.strictEqual(plainNotes([{ version: '1.6.1', note: 'A' }, { version: '1.6.2', note: 'B' }]), 'A\nB');
        assert.strictEqual(plainNotes(null), '');
        assert.ok(plainNotes('x'.repeat(2000)).length <= 700);
    });

    await check('package.json publishes to and updates from killssingkurisu/db-dpsmod', () => {
        const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
        const pub = pkg.build.publish[0];
        assert.deepStrictEqual([pub.provider, pub.owner, pub.repo], ['github', 'killssingkurisu', 'db-dpsmod']);
        assert.strictEqual(pkg.build.appId, 'io.github.killssingkurisu.dbdps');
        assert.ok(/^\d+\.\d+\.\d+$/.test(pkg.version));
        // Electron 11 is the last that hosts Flash; electron-updater 4.3.9 is the last that runs on its Node 12.
        assert.strictEqual(pkg.devDependencies.electron, '11.5.0');
        assert.strictEqual(pkg.dependencies['electron-updater'], '4.3.9');
        const main = fs.readFileSync(path.join(__dirname, '..', 'app', 'main.js'), 'utf8');
        assert.ok(main.includes("const APP_ID = '" + pkg.build.appId + "'"), 'main.js uses the same app id');
    });

    console.log('Settings');
    await check('remembers settings, and copies the meter settings from the official launcher once', () => {
        const userData = tmp('dbl-user-');
        const appData = tmp('dbl-appdata-');
        const s = new Settings(userData);
        assert.strictEqual(s.get('maximized'), true);
        s.set({ maximized: false, windowBounds: { x: 10, y: 20, width: 1300, height: 800 } });
        assert.deepStrictEqual(new Settings(userData).get('windowBounds'), { x: 10, y: 20, width: 1300, height: 800 });

        const old = path.join(appData, 'dungeon-blitz-r-launcher');
        fs.mkdirSync(old);
        fs.writeFileSync(path.join(old, 'dps-overlay.json'), '{"autoStart":true}');
        assert.deepStrictEqual(importFromOfficial(userData, appData), ['dps-overlay.json']);
        assert.strictEqual(fs.readFileSync(path.join(userData, 'dps-overlay.json'), 'utf8'), '{"autoStart":true}');
        fs.writeFileSync(path.join(old, 'dps-overlay.json'), '{"autoStart":false}');
        assert.deepStrictEqual(importFromOfficial(userData, appData), [], 'never overwrites');
    });

    await check('a window saved on a screen that is gone opens on the main one', () => {
        const displays = [{ workArea: { x: 0, y: 0, width: 2560, height: 1400 } }];
        assert.deepStrictEqual(visibleBounds({ x: 100, y: 50, width: 1280, height: 820 }, displays), { x: 100, y: 50, width: 1280, height: 820 });
        assert.deepStrictEqual(visibleBounds({ x: 3000, y: 50, width: 1280, height: 820 }, displays), { width: 1280, height: 820 });
        assert.strictEqual(visibleBounds(null, displays), null);
    });

    await check('the meter maps the official site and any other game address it opens', () => {
        assert.deepStrictEqual(webHosts([]), [{ host: 'dungeonblitzr.theminesa.studio', port: 80 }]);
        assert.deepStrictEqual(webHosts(['http://dungeonblitzr.theminesa.studio/', 'http://10.0.0.5:8081/', 'http://127.0.0.1/', 'https://secure.example/']), [
            { host: 'dungeonblitzr.theminesa.studio', port: 80 },
            { host: '10.0.0.5', port: 8081 }
        ]);
    });

    for (const d of made) fs.rmdirSync(d, { recursive: true });
    console.log('\n' + passed + ' passed, ' + failures.length + ' failed');
    process.exit(failures.length ? 1 : 0);
}

main();
