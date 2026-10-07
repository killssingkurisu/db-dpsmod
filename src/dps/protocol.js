'use strict';

/**
 * The few Dungeon Blitz packets the DPS meter reads, decoded the way the client writes them.
 *
 * Framing on the game socket (Connection.SendPacket and the Packet class in DungeonBlitz.swf):
 * a big-endian u16 packet id, a big-endian u16 payload length, then the payload. Payloads are
 * bit-packed, most significant bit first; the readers below mirror the client's Packet class
 * (method_4/9 = uint, method_24/45 = sint, method_13/26 = str, method_6(n) = bits(n)).
 */

class BitReader {
    constructor(buf) {
        this.buf = buf;
        this.bit = 0;
        this.total = buf.length * 8;
    }

    need(n) {
        if (this.bit + n > this.total) {
            throw new RangeError('packet ended early');
        }
    }

    bits(n) {
        this.need(n);
        let v = 0;
        let left = n;
        while (left > 0) {
            const byte = this.buf[this.bit >> 3];
            const off = this.bit & 7;
            const take = Math.min(left, 8 - off);
            const shift = 8 - off - take;
            v = v * (1 << take) + ((byte >> shift) & ((1 << take) - 1));
            this.bit += take;
            left -= take;
        }
        return v;
    }

    bool() {
        return this.bits(1) === 1;
    }

    /** method_4 / method_9: a 4-bit size prefix p, then (p + 1) * 2 bits. */
    uint() {
        const p = this.bits(4);
        return this.bits((p + 1) * 2);
    }

    /** method_24 / method_45: sign bit, then uint(). */
    sint() {
        const neg = this.bool();
        const v = this.uint();
        return neg ? -v : v;
    }

    /** method_706 / method_739: sign bit, a 3-bit prefix, then (p + 1) * 2 bits. */
    sint3() {
        const neg = this.bool();
        const p = this.bits(3);
        const v = this.bits((p + 1) * 2);
        return neg ? -v : v;
    }

    /** method_13 / method_26: u16 byte length, then UTF-8 bytes. */
    str() {
        const len = this.bits(16);
        this.need(len * 8);
        const out = Buffer.alloc(len);
        for (let i = 0; i < len; i++) {
            out[i] = this.bits(8);
        }
        return out.toString('utf8');
    }
}

/** Writes the same bit-packed fields BitReader reads. */
class BitWriter {
    constructor() {
        this.bytes = [];
        this.bit = 0;
    }

    bits(value, n) {
        for (let i = n - 1; i >= 0; i--) {
            const b = Math.floor(value / Math.pow(2, i)) % 2;
            const at = this.bit >> 3;
            if (at >= this.bytes.length) this.bytes.push(0);
            if (b) this.bytes[at] |= 0x80 >> (this.bit & 7);
            this.bit += 1;
        }
    }

    bool(v) {
        this.bits(v ? 1 : 0, 1);
    }

    /** method_9: the fewest even number of bits that hold the value, as a 4-bit prefix (bits / 2 - 1). */
    uint(v) {
        let width = Math.max(1, Math.floor(v).toString(2).length);
        width += width & 1;
        this.bits(width / 2 - 1, 4);
        this.bits(v, width);
    }

    str(s) {
        const b = Buffer.from(String(s), 'utf8');
        this.bits(b.length, 16);
        for (const x of b) this.bits(x, 8);
    }

    /** Copies `count` bits of `buf` starting at bit `from`. */
    copy(buf, from, count) {
        const r = new BitReader(buf);
        r.bit = from;
        let left = count;
        while (left > 0) {
            const n = Math.min(left, 24);
            this.bits(r.bits(n), n);
            left -= n;
        }
    }

    toBuffer() {
        return Buffer.from(this.bytes);
    }
}

const PKT = {
    ENT_INCREMENTAL_UPDATE: 0x07,
    ENT_FULL_UPDATE: 0x08,
    POWER_CAST: 0x09,
    POWER_HIT: 0x0a,
    ENT_DESTROY: 0x0d,
    NEWLY_RELEVANT_ENTITY: 0x0f,
    ENTER_WORLD: 0x21,
    /** Client -> server when the dungeon is beaten (Level.method_682): completion %, then stats. */
    SET_LEVEL_COMPLETE: 0x3f,
    BUFF_TICK_DOT: 0x79,
    /** Server -> client: the dungeon is beaten; the client opens its Level Complete screen. */
    RECV_LEVEL_COMPLETE: 0x87,
    /** Both ways: the dungeon's completion percent (Level.var_690), whenever its rounded value changes. */
    LEVEL_COMPLETION: 0xb7
};

/** Entity.entState values (2 bits). 3 (Entity.const_6) is dead: HP reached 0. */
const ENT_STATE = { DEAD: 3 };

const TEAM = { UNKNOWN: 0, PLAYER: 1, ENEMY: 2, NPC: 3 };

/** 0x08, client -> server: the full state of an entity this client owns (its own body, its summons, its mobs). */
function parseEntityFullUpdate(payload) {
    const r = new BitReader(payload);
    const id = r.uint();
    r.sint(); // x
    r.sint(); // y
    r.sint(); // velocity x
    let name = r.str();
    const team = r.bits(2);
    const isPlayer = r.bool();
    r.sint3(); // y offset
    if (r.bool()) {
        if (r.bool()) {
            const cueName = r.str();
            // ",Name" overrides the entity type for server-side identification.
            if (cueName.startsWith(',') && cueName.length > 1) {
                name = cueName.substring(1);
            }
        }
        if (r.bool()) r.str(); // drama anim
        if (r.bool()) r.str(); // sleep anim
    }
    const summonerId = r.bool() ? r.uint() : 0;
    const powerId = r.bool() ? r.uint() : 0;
    let entState = 0;
    try {
        entState = r.bits(2);
    } catch (_e) {
        // a short packet: alive as far as we know
    }
    return { id, name, team, isPlayer, summonerId, powerId, entState };
}

/**
 * 0x07, both ways: an entity's movement since its last update, and its state (LinkUpdater.method_541:
 * id, dx, dy, dvx, entState in 2 bits, then flags). The client sends it for what it runs (its own
 * body, its mobs); the server forwards other clients' to it.
 */
function parseIncrementalUpdate(payload) {
    const r = new BitReader(payload);
    const id = r.uint();
    r.sint(); // dx
    r.sint(); // dy
    r.sint(); // dvx
    return { id, entState: r.bits(2) };
}

/** 0xb7, both ways: the dungeon's completion percent (0-100). */
function parseLevelCompletion(payload) {
    return { percent: new BitReader(payload).uint() };
}

/** 0x09, both directions: a power cast. */
function parsePowerCast(payload) {
    const r = new BitReader(payload);
    const sourceId = r.uint();
    const powerId = r.uint();
    const hasTargetEntity = r.bool();
    const hasTargetPos = r.bool();
    if (hasTargetPos) {
        r.sint();
        r.sint();
    }
    const projectileId = r.bool() ? r.uint() : null;
    const isPersistent = r.bool();
    let combo = null;
    if (r.bool()) {
        const isMelee = r.bool();
        combo = { isMelee, id: r.uint() };
    }
    return { sourceId, powerId, hasTargetEntity, hasTargetPos, projectileId, isPersistent, combo };
}

/** 0x0A, both directions: a hit and the damage the attacker's client worked out for it. */
function parsePowerHit(payload) {
    const r = new BitReader(payload);
    const targetId = r.uint();
    const sourceId = r.uint();
    const damage = r.sint();
    const powerId = r.uint();
    const animOverrideId = r.bool() ? r.uint() : 0;
    const effectOverrideId = r.bool() ? r.uint() : 0;
    const isCrit = r.bool();
    return { targetId, sourceId, damage, powerId, animOverrideId, effectOverrideId, isCrit };
}

/** 0x79, both directions: one tick of a damage-over-time buff. */
function parseBuffTickDot(payload) {
    const r = new BitReader(payload);
    const targetId = r.uint();
    const sourceId = r.uint();
    const powerId = r.uint();
    const amount = r.sint();
    return { targetId, sourceId, powerId, amount };
}

/** 0x0F, server -> client: an entity coming into view. Only the leading fields are read. */
function parseNewlyRelevantEntity(payload) {
    const r = new BitReader(payload);
    const id = r.uint();
    const name = r.str();
    const isPlayer = r.bits(1) === 1;
    let team = isPlayer ? TEAM.PLAYER : TEAM.UNKNOWN;
    let className = '';
    if (isPlayer) {
        className = r.str();
    } else {
        try {
            r.sint();
            r.sint();
            r.sint();
            team = r.bits(2);
        } catch (_e) {
            team = TEAM.UNKNOWN;
        }
    }
    return { id, name, isPlayer, team, className };
}

/** 0x21, server -> client: enter world. Carries the game server to reconnect to and the level. */
function parseEnterWorld(payload) {
    const r = new BitReader(payload);
    r.uint(); // transfer token
    r.uint(); // old level id
    r.str(); // old swf
    if (r.bool()) {
        r.uint();
        r.uint();
    }
    const host = r.str();
    const port = r.uint();
    const swf = r.str();
    const mapLevel = r.bits(6);
    const baseLevel = r.bits(6);
    const level = r.str();
    r.str(); // moment params
    const alter = r.str();
    const isDungeon = r.bool();
    return { host, port, swf, mapLevel, baseLevel, level, alter, isDungeon };
}

/**
 * Returns a copy of an enter-world payload (0x21) with the game server's host and port replaced.
 * Every other bit is copied as it was; the copy can end in one more byte of zero padding.
 */
function rewriteEnterWorld(payload, host, port) {
    const r = new BitReader(payload);
    r.uint();
    r.uint();
    r.str();
    if (r.bool()) {
        r.uint();
        r.uint();
    }
    const hostAt = r.bit;
    const oldHost = r.str();
    const oldPort = r.uint();
    const restAt = r.bit;
    const w = new BitWriter();
    w.copy(payload, 0, hostAt);
    w.str(host);
    w.uint(port);
    w.copy(payload, restAt, payload.length * 8 - restAt);
    return { payload: w.toBuffer(), host: oldHost, port: oldPort };
}

function frame(id, payload) {
    const head = Buffer.alloc(4);
    head.writeUInt16BE(id, 0);
    head.writeUInt16BE(payload.length, 2);
    return Buffer.concat([head, payload]);
}

/**
 * Splits a byte stream into packets. Feed it every chunk in order; it calls onPacket(id, payload)
 * for each complete packet and keeps the remainder. A Flash socket-policy exchange
 * ("<policy-file-request/>" or the XML answer, both NUL-terminated) is skipped whole.
 */
class PacketSplitter {
    constructor(onPacket) {
        this.onPacket = onPacket;
        this.buf = Buffer.alloc(0);
        this.dead = false;
    }

    push(chunk) {
        if (this.dead) {
            return;
        }
        this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : Buffer.from(chunk);
        for (;;) {
            if (this.buf.length && this.buf[0] === 0x3c) {
                // '<': a socket policy request or answer, ended by a NUL byte.
                const end = this.buf.indexOf(0);
                if (end < 0) {
                    if (this.buf.length > 4096) {
                        this.dead = true;
                    }
                    return;
                }
                this.buf = this.buf.subarray(end + 1);
                continue;
            }
            if (this.buf.length < 4) {
                return;
            }
            const id = this.buf.readUInt16BE(0);
            const len = this.buf.readUInt16BE(2);
            if (this.buf.length < 4 + len) {
                return;
            }
            const payload = this.buf.subarray(4, 4 + len);
            this.buf = this.buf.subarray(4 + len);
            try {
                this.onPacket(id, payload);
            } catch (_e) {
                // A packet we misread must never stop the stream: the bytes are already forwarded.
            }
        }
    }
}

module.exports = {
    BitReader,
    BitWriter,
    PacketSplitter,
    rewriteEnterWorld,
    frame,
    PKT,
    ENT_STATE,
    parseIncrementalUpdate,
    parseLevelCompletion,
    TEAM,
    parseEntityFullUpdate,
    parsePowerCast,
    parsePowerHit,
    parseBuffTickDot,
    parseNewlyRelevantEntity,
    parseEnterWorld
};
