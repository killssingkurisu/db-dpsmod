'use strict';

const zlib = require('zlib');

/**
 * Points DungeonBlitz.swf's login connection at the meter's relay on this computer.
 *
 * Flash's sockets don't go through Chromium's host mapping, so the client itself has to be told
 * where to connect. It logs in to a host and port set in two class initialisers:
 *
 *   LinkUpdater:  findproperty const_1264;       pushstring "<login host>"; initproperty const_1264
 *   Connection:   findproperty LOGINSERVER_PORT; pushshort <login port>;    initproperty LOGINSERVER_PORT
 *
 * readLoginTarget() reads those two operands; patchSwf() swaps them for "127.0.0.1" and the
 * relay's port. Nothing else changes: other uses of the same host string (where assets are
 * downloaded from) are left alone, and each new operand takes exactly as many bytes as the old
 * one, so no method body changes length and no branch moves. Every later server comes from the
 * server in packet 0x21, through the relay, which points those at itself too.
 *
 * One more change makes damage over time on the house training dummies visible. Buff's tick sends
 * each DoT tick to the server (packet 0x79) unless the target's behaviour is HomeDummy:
 *
 *   getlocal0; getproperty var_4; getproperty behaviorType; getproperty var_2303; ...; iftrue <skip>
 *   findpropstrict Packet; getlex LinkUpdater; getproperty PKTTYPE_BUFF_TICK_DOT; ...
 *
 * `getproperty var_2303` becomes `pop; pushfalse` (plus a nop to keep the length), so those
 * ticks are sent too, and the relay keeps them: a tick on a HomeDummy never reaches the server,
 * which therefore sees exactly what an unmodified client sends.
 */

const OP = { findpropstrict: 0x5d, findproperty: 0x5e, pushstring: 0x2c, pushshort: 0x25, initproperty: 0x68, setproperty: 0x61, getproperty: 0x66, pop: 0x29, pushfalse: 0x27, nop: 0x02 };
const QNAME = 0x07;

function readU30(b, o) {
    let v = 0;
    let n = 0;
    for (;;) {
        const c = b[o + n];
        v += (c & 0x7f) * Math.pow(2, 7 * n);
        n += 1;
        if (!(c & 0x80) || n >= 5) break;
    }
    return { v, n };
}

/** u30 bytes for v, at least `len` long (extra continuation groups decode to the same value). */
function encodeU30(v, len) {
    const out = [];
    let x = v;
    do {
        out.push(x & 0x7f);
        x = Math.floor(x / 128);
    } while (x > 0);
    while (out.length < (len || 0)) out.push(0);
    for (let i = 0; i < out.length - 1; i++) out[i] |= 0x80;
    return Buffer.from(out);
}

function u30Size(v) {
    return encodeU30(v, 0).length;
}

/** The ABC constant pool, read as far as the multinames. */
function readPool(abc) {
    let q = 4; // minor, major version
    const skipList = (each) => {
        const c = readU30(abc, q);
        q += c.n;
        for (let i = 1; i < c.v; i++) each();
        return c.v;
    };
    skipList(() => (q += readU30(abc, q).n)); // ints
    skipList(() => (q += readU30(abc, q).n)); // uints
    const d = readU30(abc, q);
    q += d.n + 8 * Math.max(0, d.v - 1); // doubles
    const stringCountAt = q;
    const sc = readU30(abc, q);
    q += sc.n;
    const strings = [''];
    for (let i = 1; i < sc.v; i++) {
        const len = readU30(abc, q);
        q += len.n;
        strings.push(abc.toString('utf8', q, q + len.v));
        q += len.v;
    }
    const stringsEnd = q;
    skipList(() => {
        q += 1;
        q += readU30(abc, q).n;
    }); // namespaces
    skipList(() => {
        const c = readU30(abc, q);
        q += c.n;
        for (let i = 0; i < c.v; i++) q += readU30(abc, q).n;
    }); // namespace sets
    const multinames = [null];
    const mc = readU30(abc, q);
    q += mc.n;
    for (let i = 1; i < mc.v; i++) {
        const kind = abc[q++];
        let name = -1;
        const u = () => {
            const r = readU30(abc, q);
            q += r.n;
            return r.v;
        };
        switch (kind) {
            case 0x07:
            case 0x0d: // QName(A): ns, name
                u();
                name = u();
                break;
            case 0x0f:
            case 0x10: // RTQName(A): name
                name = u();
                break;
            case 0x11:
            case 0x12: // RTQNameL(A)
                break;
            case 0x09:
            case 0x0e: // Multiname(A): name, ns set
                name = u();
                u();
                break;
            case 0x1b:
            case 0x1c: // MultinameL(A): ns set
                u();
                break;
            case 0x1d: {
                // TypeName: qname, params
                u();
                const n = u();
                for (let k = 0; k < n; k++) u();
                break;
            }
            default:
                throw new Error('unknown multiname kind ' + kind);
        }
        multinames.push({ kind, name });
    }
    return { strings, stringCountAt, stringCount: sc.v, stringsEnd };
}

/**
 * Finds `findproperty M; <op> <operand>; initproperty|setproperty M` for each multiname index in
 * `mnIndexes`, and returns each operand's position, byte length and value.
 */
function findAssignments(abc, mnIndexes, op) {
    const hits = [];
    for (const m of mnIndexes) {
        const mb = encodeU30(m, 0);
        for (const find of [OP.findproperty, OP.findpropstrict]) {
            const head = Buffer.concat([Buffer.from([find]), mb, Buffer.from([op])]);
            let at = abc.indexOf(head);
            while (at >= 0) {
                const opndAt = at + head.length;
                const opnd = readU30(abc, opndAt);
                const after = opndAt + opnd.n;
                if ((abc[after] === OP.initproperty || abc[after] === OP.setproperty) && abc.subarray(after + 1, after + 1 + mb.length).equals(mb)) {
                    hits.push({ at: opndAt, len: opnd.n, value: opnd.v });
                }
                at = abc.indexOf(head, at + 1);
            }
        }
    }
    return hits;
}

function multinamesNamed(abc, pool, name) {
    const idx = pool.strings.indexOf(name);
    if (idx < 0) return [];
    // Re-read the multinames to know their indexes (readPool keeps only what it needs).
    const out = [];
    let q = pool.stringsEnd;
    const u = () => {
        const r = readU30(abc, q);
        q += r.n;
        return r.v;
    };
    let c = u();
    for (let i = 1; i < c; i++) {
        q += 1;
        u();
    }
    c = u();
    for (let i = 1; i < c; i++) {
        const n = u();
        for (let k = 0; k < n; k++) u();
    }
    c = u();
    for (let i = 1; i < c; i++) {
        const kind = abc[q++];
        let nm = -1;
        if (kind === 0x07 || kind === 0x0d) {
            u();
            nm = u();
        } else if (kind === 0x0f || kind === 0x10) {
            nm = u();
        } else if (kind === 0x09 || kind === 0x0e) {
            nm = u();
            u();
        } else if (kind === 0x1b || kind === 0x1c) {
            u();
        } else if (kind === 0x1d) {
            u();
            const n = u();
            for (let k = 0; k < n; k++) u();
        }
        if (nm === idx && (kind === QNAME || kind === 0x0d)) out.push(i);
    }
    return out;
}

/** Adds a string to the pool; returns the new ABC and the string's index. */
function appendString(abc, pool, s) {
    const bytes = Buffer.from(s, 'utf8');
    const countOld = readU30(abc, pool.stringCountAt);
    const parts = [
        abc.subarray(0, pool.stringCountAt),
        encodeU30(pool.stringCount + 1, 0),
        abc.subarray(pool.stringCountAt + countOld.n, pool.stringsEnd),
        encodeU30(bytes.length, 0),
        bytes,
        abc.subarray(pool.stringsEnd)
    ];
    return { abc: Buffer.concat(parts), index: pool.stringCount };
}

/**
 * Finds `getproperty var_2303` (the HomeDummy flag) where it guards the DoT tick packet, i.e.
 * followed within a few instructions by `getproperty PKTTYPE_BUFF_TICK_DOT`.
 */
function findDummyDotChecks(abc, pool) {
    const flags = multinamesNamed(abc, pool, 'var_2303');
    const tick = multinamesNamed(abc, pool, 'PKTTYPE_BUFF_TICK_DOT').map((m) => Buffer.concat([Buffer.from([OP.getproperty]), encodeU30(m, 0)]));
    const hits = [];
    for (const m of flags) {
        const ins = Buffer.concat([Buffer.from([OP.getproperty]), encodeU30(m, 0)]);
        let at = abc.indexOf(ins);
        while (at >= 0) {
            const window = abc.subarray(at + ins.length, at + ins.length + 48);
            if (tick.some((t) => window.indexOf(t) >= 0)) hits.push({ at, len: ins.length });
            at = abc.indexOf(ins, at + 1);
        }
    }
    return hits;
}

/** Reads, and with opts.port set also patches, the login host and port in one ABC block. */
function patchAbc(abcIn, opts) {
    let abc = Buffer.from(abcIn);
    let pool = readPool(abc);
    const report = { originalHost: '', originalPort: 0, hostPatches: 0, portPatches: 0, dummyDotPatches: 0 };
    const hostHits = findAssignments(abc, multinamesNamed(abc, pool, 'const_1264'), OP.pushstring);
    const portHits = findAssignments(abc, multinamesNamed(abc, pool, 'LOGINSERVER_PORT'), OP.pushshort);
    if (hostHits.length) report.originalHost = pool.strings[hostHits[0].value] || '';
    if (portHits.length) report.originalPort = portHits[0].value & 0xffff;
    if (!opts.port || !hostHits.length || !portHits.length) {
        return { abc: abcIn, report, changed: false };
    }
    let loopIdx = pool.strings.indexOf(opts.host);
    if (loopIdx < 0) {
        const added = appendString(abc, pool, opts.host);
        abc = added.abc;
        loopIdx = added.index;
        pool = readPool(abc);
        // the string pool grew, so every operand after it moved
        hostHits.length = 0;
        portHits.length = 0;
        hostHits.push(...findAssignments(abc, multinamesNamed(abc, pool, 'const_1264'), OP.pushstring));
        portHits.push(...findAssignments(abc, multinamesNamed(abc, pool, 'LOGINSERVER_PORT'), OP.pushshort));
    }
    for (const hit of hostHits) {
        if (u30Size(loopIdx) > hit.len) throw new Error('the replacement host does not fit the original operand');
        encodeU30(loopIdx, hit.len).copy(abc, hit.at);
        report.hostPatches += 1;
    }
    for (const hit of portHits) {
        if (u30Size(opts.port) > hit.len) throw new Error('the relay port does not fit the original operand');
        encodeU30(opts.port, hit.len).copy(abc, hit.at);
        report.portPatches += 1;
    }
    if (opts.dummyDots !== false) {
        for (const hit of findDummyDotChecks(abc, pool)) {
            const code = [OP.pop, OP.pushfalse];
            while (code.length < hit.len) code.push(OP.nop);
            Buffer.from(code).copy(abc, hit.at);
            report.dummyDotPatches += 1;
        }
    }
    return { abc, report, changed: true };
}

function eachAbc(swf, fn) {
    const sig = swf.toString('latin1', 0, 3);
    if (sig !== 'CWS' && sig !== 'FWS') throw new Error('not a zlib or uncompressed SWF (' + sig + ')');
    const version = swf[3];
    const body = sig === 'CWS' ? zlib.inflateSync(swf.subarray(8)) : swf.subarray(8);
    const nbits = body[0] >> 3;
    let p = Math.ceil((5 + nbits * 4) / 8) + 4;
    const out = [body.subarray(0, p)];
    let changed = false;
    while (p < body.length) {
        const h = body.readUInt16LE(p);
        const code = h >> 6;
        let len = h & 0x3f;
        let hl = 2;
        if (len === 0x3f) {
            len = body.readUInt32LE(p + 2);
            hl = 6;
        }
        const data = body.subarray(p + hl, p + hl + len);
        let tag = body.subarray(p, p + hl + len);
        if (code === 82 || code === 72) {
            let abcAt = 0;
            if (code === 82) {
                abcAt = 4;
                while (data[abcAt] !== 0) abcAt++;
                abcAt++;
            }
            const abc = fn(data.subarray(abcAt));
            if (abc) {
                changed = true;
                const newData = Buffer.concat([data.subarray(0, abcAt), abc]);
                const head = Buffer.alloc(6);
                head.writeUInt16LE((code << 6) | 0x3f, 0);
                head.writeUInt32LE(newData.length, 2);
                tag = Buffer.concat([head, newData]);
            }
        }
        out.push(tag);
        p += hl + len;
        if (code === 0) break;
    }
    if (!changed) return swf;
    const newBody = Buffer.concat(out);
    const header = Buffer.alloc(8);
    header.write(sig, 0, 'latin1');
    header[3] = version;
    header.writeUInt32LE(newBody.length + 8, 4);
    return Buffer.concat([header, sig === 'CWS' ? zlib.deflateSync(newBody, { level: 6 }) : newBody]);
}

/** The login server the SWF connects to: { host, port }, or null when it can't be found. */
function readLoginTarget(swf) {
    let found = null;
    eachAbc(swf, (abc) => {
        const r = patchAbc(abc, {}).report;
        if (!found && r.originalHost && r.originalPort) found = { host: r.originalHost, port: r.originalPort };
        return null;
    });
    return found;
}

/**
 * Returns { swf, report }. report.ok is true when the login host and the login port were both
 * patched (exactly one port); otherwise the caller should serve the original.
 */
function patchSwf(swf, opts) {
    const o = Object.assign({ host: '127.0.0.1' }, opts);
    if (!(o.port > 0 && o.port < 16384)) throw new Error('the login port must be below 16384 (it replaces a two-byte operand)');
    const report = { ok: false, originalHost: '', originalPort: 0, hostPatches: 0, portPatches: 0, dummyDotPatches: 0 };
    const out = eachAbc(swf, (abc) => {
        const r = patchAbc(abc, o);
        if (r.report.originalHost && !report.originalHost) report.originalHost = r.report.originalHost;
        if (r.report.originalPort && !report.originalPort) report.originalPort = r.report.originalPort;
        report.hostPatches += r.report.hostPatches;
        report.portPatches += r.report.portPatches;
        report.dummyDotPatches += r.report.dummyDotPatches;
        return r.changed ? r.abc : null;
    });
    report.ok = report.hostPatches >= 1 && report.portPatches === 1;
    return { swf: out, report };
}

module.exports = { patchSwf, readLoginTarget, encodeU30, readU30, readPool };
