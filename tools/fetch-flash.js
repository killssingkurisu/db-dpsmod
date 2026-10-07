'use strict';

/**
 * Puts the Flash plugin the launcher ships with in vendor/flash/win32/pepflashplayer64.dll,
 * where the build picks it up (package.json build.extraResources).
 *
 * The plugin never goes into the repository. This takes it out of FlashBrowser's public Windows
 * installer (github.com/radubirsan/FlashBrowser, v0.81, an Inno Setup installer), using
 * innoextract, and checks both files against pinned SHA-256 hashes: Flash Player 32.0.0.363,
 * 64-bit, the same build the official Dungeon Blitz R launcher ships.
 *
 *   node tools/fetch-flash.js                 download and extract (needs innoextract on PATH)
 *   node tools/fetch-flash.js --from <dll>    use a copy you already have (checked the same way)
 */

const crypto = require('crypto');
const fs = require('fs');
const https = require('https');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const INSTALLER_URL = 'https://github.com/radubirsan/FlashBrowser/releases/download/v0.81/v0.81_FlashBrowser_x64.exe';
const INSTALLER_SHA256 = 'ce573c0b8c54161b468056ab6c62214edea12b05c1c25e1bbb6e54ace8a703ec';
const PLUGIN_IN_INSTALLER = 'app/resources/app/flashver/pepflashplayer64.dll';
const PLUGIN_SHA256 = '4acafedca8bb62529527029aeb485318866e4fd71bf298e73f735bc75f6d720d';
const OUT = path.join(__dirname, '..', 'vendor', 'flash', 'win32', 'pepflashplayer64.dll');

function sha256(file) {
    return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function download(url, file, redirects) {
    return new Promise((resolve, reject) => {
        https
            .get(url, { headers: { 'user-agent': 'db-dps-launcher-build' } }, (res) => {
                if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && (redirects || 0) < 8) {
                    res.resume();
                    resolve(download(new URL(res.headers.location, url).toString(), file, (redirects || 0) + 1));
                    return;
                }
                if (res.statusCode !== 200) {
                    res.resume();
                    reject(new Error('HTTP ' + res.statusCode + ' for ' + url));
                    return;
                }
                const out = fs.createWriteStream(file);
                res.pipe(out);
                out.on('finish', () => out.close(resolve));
                out.on('error', reject);
                res.on('error', reject);
            })
            .on('error', reject);
    });
}

function place(dll) {
    const got = sha256(dll);
    if (got !== PLUGIN_SHA256) {
        throw new Error('The Flash plugin is not the expected build (SHA-256 ' + got + ', expected ' + PLUGIN_SHA256 + ').');
    }
    fs.mkdirSync(path.dirname(OUT), { recursive: true });
    fs.copyFileSync(dll, OUT);
    console.log('Flash plugin ready: ' + OUT + ' (SHA-256 ' + got + ')');
}

async function main() {
    const i = process.argv.indexOf('--from');
    if (i > 0) {
        place(path.resolve(process.argv[i + 1]));
        return;
    }
    if (fs.existsSync(OUT) && sha256(OUT) === PLUGIN_SHA256) {
        console.log('Flash plugin already in place: ' + OUT);
        return;
    }
    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'fetch-flash-'));
    try {
        const installer = path.join(work, 'FlashBrowser_x64.exe');
        console.log('Downloading ' + INSTALLER_URL);
        await download(INSTALLER_URL, installer);
        const got = sha256(installer);
        if (got !== INSTALLER_SHA256) {
            throw new Error('The FlashBrowser installer changed (SHA-256 ' + got + ', expected ' + INSTALLER_SHA256 + ').');
        }
        const extracted = path.join(work, 'x');
        execFileSync('innoextract', ['--silent', '--output-dir', extracted, '--include', path.posix.dirname(PLUGIN_IN_INSTALLER), installer], { stdio: 'inherit' });
        place(path.join(extracted, ...PLUGIN_IN_INSTALLER.split('/')));
    } finally {
        fs.rmdirSync(work, { recursive: true });
    }
}

main().catch((err) => {
    console.error(String((err && err.message) || err));
    process.exit(1);
});
