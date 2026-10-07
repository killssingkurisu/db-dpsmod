'use strict';

const zlib = require('zlib');

/**
 * Unpacks a Dungeon Blitz .swz archive (the client's packed XML: Game.swz, Login.swz).
 *
 * Layout: u32 key, u32 chunk count, then per chunk a u32 length and that many bytes XORed with
 * a rolling key (low byte of the key, which is rotated right by (i & 7) after every byte and
 * carries over from one chunk to the next), each chunk being zlib-compressed UTF-8 XML.
 * Same algorithm as tools/build_catalog.py in the scanner.
 */
function unpackSwz(buf) {
    let key = buf.readUInt32BE(0) >>> 0;
    const count = buf.readUInt32BE(4);
    let pos = 8;
    const out = [];
    for (let c = 0; c < count; c++) {
        const n = buf.readUInt32BE(pos);
        pos += 4;
        const chunk = Buffer.alloc(n);
        for (let j = 0; j < n; j++) {
            chunk[j] = buf[pos + j] ^ (key & 0xff);
            const s = j & 7;
            if (s) {
                key = ((key << (32 - s)) | (key >>> s)) >>> 0;
            }
        }
        pos += n;
        out.push(zlib.inflateSync(chunk).toString('utf8'));
    }
    return out;
}

/** The chunk whose root element is `root` (e.g. "PlayerPowerTypes"), or ''. */
function chunkByRoot(chunks, root) {
    const re = new RegExp('<' + root + '[\\s>]');
    for (const c of chunks) {
        if (re.test(c.slice(0, 400))) {
            return c;
        }
    }
    return '';
}

module.exports = { unpackSwz, chunkByRoot };
