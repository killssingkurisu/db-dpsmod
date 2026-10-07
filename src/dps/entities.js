'use strict';

const { unpackSwz, chunkByRoot } = require('./swz');

/**
 * Monster ranks from the game's EntTypes (inside Login.swz): which entity types are bosses.
 *
 * Every EntType has an EntRank (Minion, Lieutenant, MiniBoss, Boss, Pet) or inherits one from its
 * parent ("<EntType EntName="GoblinBoss1Hard" parent="GoblinBoss1">"). Dungeon mode stops the
 * clock when a Boss dies; the packets name entities by their EntName.
 */

function tag(block, name) {
    const m = new RegExp('<' + name + '>([^<]*)</' + name + '>').exec(block);
    return m ? m[1].trim() : '';
}

/** EntName -> { rank, displayName }, ranks and names filled in from parents. */
function parseEntTypes(xml) {
    const raw = new Map();
    const re = /<EntType EntName="([^"]+)"(?:\s+parent="([^"]*)")?\s*>([\s\S]*?)<\/EntType>/g;
    let m;
    while ((m = re.exec(xml))) {
        raw.set(m[1], { parent: m[2] || '', rank: tag(m[3], 'EntRank'), displayName: tag(m[3], 'DisplayName') });
    }
    const resolve = (name, field, depth) => {
        const t = raw.get(name);
        if (!t || depth > 30) return '';
        return t[field] || resolve(t.parent, field, depth + 1);
    };
    const out = new Map();
    for (const name of raw.keys()) {
        out.set(name, { rank: resolve(name, 'rank', 0), displayName: resolve(name, 'displayName', 0) });
    }
    return out;
}

/** The compact data set: { version, source, builtAt, bosses: { EntName: displayName } }. */
function bossesFromXml(xml, source) {
    const bosses = {};
    for (const [name, t] of parseEntTypes(xml)) {
        if (t.rank === 'Boss') bosses[name] = t.displayName || name;
    }
    return { version: 1, source: source || 'Login.swz', builtAt: new Date().toISOString(), bosses };
}

function bossesFromSwz(buf, source) {
    const xml = chunkByRoot(unpackSwz(buf), 'EntTypes');
    if (!xml) throw new Error('Login.swz has no EntTypes');
    return bossesFromXml(xml, source);
}

/** Boss lookups, built from that data set. */
class BossTable {
    constructor(data) {
        this.source = (data && data.source) || '';
        this.names = new Map(Object.entries((data && data.bosses) || {}));
    }

    has(name) {
        return this.names.has(String(name || ''));
    }

    /** "BanditBoss" -> "Svagg". */
    displayName(name) {
        return this.names.get(String(name || '')) || String(name || '');
    }

    get size() {
        return this.names.size;
    }
}

module.exports = { parseEntTypes, bossesFromXml, bossesFromSwz, BossTable };
