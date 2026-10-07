'use strict';

/**
 * Checks for the DPS meter that run under plain Node (12+): packet decoding, the relay end to
 * end over real sockets, the meter's arithmetic, the export formats and the power table.
 * test/launcher.js checks the launcher around it.
 *
 *   node test/run.js
 *
 * DBDPS_LIVE_SWF=<DungeonBlitz.swf> also patches a real client and checks what changed.
 */

const assert = require('assert');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');

const P = require('../src/dps/protocol');
const http = require('http');
const { GameRelay, RelayHub, CombatTracker, POLICY } = require('../src/dps/relay');
const { WebProxy } = require('../src/dps/httpProxy');
const swfpatch = require('../src/dps/swfpatch');
const { DpsMeter } = require('../src/dps/meter');
const { PowerTable, parseScaling } = require('../src/dps/powers');
const exporter = require('../src/dps/exporter');
const { readScan } = require('../src/dps/spellScans');

let passed = 0;
const failures = [];
async function check(name, fn) {
    try {
        await fn();
        passed += 1;
        console.log('  ok   ' + name);
    } catch (err) {
        failures.push(name);
        console.log('  FAIL ' + name + '\n       ' + ((err && err.stack) || err).split('\n').slice(0, 4).join('\n       '));
    }
}

/* ---------- a writer that encodes like the client's Packet class ---------- */

class BitWriter {
    constructor() {
        this.bits = [];
    }
    raw(value, n) {
        for (let i = n - 1; i >= 0; i--) this.bits.push(Math.floor(value / Math.pow(2, i)) % 2);
        return this;
    }
    bool(b) {
        return this.raw(b ? 1 : 0, 1);
    }
    uint(v) {
        const need = v > 0 ? Math.floor(Math.log2(v)) + 1 : 1;
        const use = Math.max(2, (need + 1) & ~1);
        this.raw(use / 2 - 1, 4);
        return this.raw(v, use);
    }
    sint(v) {
        this.bool(v < 0);
        return this.uint(Math.abs(v));
    }
    sint3(v) {
        this.bool(v < 0);
        const a = Math.abs(v);
        const need = a > 0 ? Math.floor(Math.log2(a)) + 1 : 1;
        const use = Math.max(2, (need + 1) & ~1);
        this.raw(use / 2 - 1, 3);
        return this.raw(a, use);
    }
    str(s) {
        const b = Buffer.from(s, 'utf8');
        this.raw(b.length, 16);
        for (const x of b) this.raw(x, 8);
        return this;
    }
    buffer() {
        const bits = this.bits.slice();
        while (bits.length % 8) bits.push(0);
        const out = Buffer.alloc(bits.length / 8);
        for (let i = 0; i < bits.length; i++) if (bits[i]) out[i >> 3] |= 0x80 >> (i & 7);
        return out;
    }
}

function frame(id, payload) {
    const h = Buffer.alloc(4);
    h.writeUInt16BE(id, 0);
    h.writeUInt16BE(payload.length, 2);
    return Buffer.concat([h, payload]);
}

const pkt = {
    fullUpdate: (id, name, { isPlayer = false, team = 1, summoner = 0, power = 0 } = {}) => {
        const w = new BitWriter().uint(id).sint(1200).sint(-40).sint(0).str(name).raw(team, 2).bool(isPlayer).sint3(0).bool(false);
        w.bool(Boolean(summoner));
        if (summoner) w.uint(summoner);
        w.bool(Boolean(power));
        if (power) w.uint(power);
        return frame(0x08, w.raw(0, 2).bool(true).bool(false).bool(false).bool(false).bool(false).buffer());
    },
    cast: (source, power) => frame(0x09, new BitWriter().uint(source).uint(power).bool(true).bool(false).bool(false).bool(false).bool(false).bool(false).buffer()),
    hit: (target, source, damage, power, crit) =>
        frame(0x0a, new BitWriter().uint(target).uint(source).sint(damage).uint(power).bool(false).bool(false).bool(crit).buffer()),
    // A proc's hit, as CombatState.method_72 fires it: the power that set it off in the first optional id.
    procHit: (target, source, damage, power, origin, crit) =>
        frame(0x0a, new BitWriter().uint(target).uint(source).sint(damage).uint(power).bool(true).uint(origin).bool(true).uint(2).bool(crit).buffer()),
    dot: (target, source, power, amount) => frame(0x79, new BitWriter().uint(target).uint(source).uint(power).sint(amount).raw(0, 5).buffer()),
    // 0x07 as LinkUpdater.method_541 writes it: id, dx, dy, dvx, entState (2 bits), flags.
    move: (id, state) => frame(0x07, new BitWriter().uint(id).sint(3).sint(-2).sint(0).raw(state, 2).bool(true).bool(false).bool(false).bool(false).bool(false).bool(false).buffer()),
    completion: (percent) => frame(0xb7, new BitWriter().uint(percent).buffer()),
    setLevelComplete: (percent) => frame(0x3f, new BitWriter().uint(percent).uint(40).uint(3).uint(0).uint(2).uint(1).uint(255).uint(0).buffer()),
    recvLevelComplete: () => frame(0x87, new BitWriter().uint(97).uint(40).buffer()),
    spawn: (id, name, isPlayer, team) => {
        const w = new BitWriter().uint(id).str(name).raw(isPlayer ? 1 : 0, 1);
        if (isPlayer) w.str('Rogue');
        else w.sint(500).sint(20).sint(0).raw(team, 2);
        return frame(0x0f, w.buffer());
    },
    enterWorld: (host, port, level) =>
        frame(0x21, new BitWriter().uint(4321).uint(0).str('').bool(false).str(host).uint(port).str('LevelsHome.swf/a_Level_Home').raw(50, 6).raw(50, 6)
            .str(level).str('').str('').bool(false).bool(false).bool(false).buffer())
};

/* ---------- a small power table ---------- */

const POWER_DATA = {
    powers: [
        [993, 'PoisonStrike10', 'PoisonStrike', 'Poison Strike', 'Physical', '20', 0, 'Deal two venomous strikes [Stats: 1.49x attack, 2x Expertise/s (5s), -10% Speed (5s)]', 0],
        [984, 'PoisonStrike1', 'PoisonStrike', 'Poison Strike', 'Physical', '20', 0, 'x [Stats: 1x attack, 2x attack/s (5s) | Next rank: 1.1x attack, 2x attack/s (5s)]', 0],
        [500, 'FireBolt5', 'FireBolt', 'Fire Bolt', 'Fire', '25', 0, 'Hurl fire', 0],
        [3, 'SwordMelee', '', 'Sword Melee', 'Physical', '0,5', 0, '', 0],
        [4000, 'SkeletonSlash', '', '', 'Physical', '0', 0, '', 1],
        [1094, 'PoisonDagger', '', 'Bone Daggers', 'Nature', '0,5', 0, 'Ranged basic attacks leave Poison [Stats: 0.8x attack, 0.5x Expertise/s (5s)]', 0, 'ProjectilePlayer'],
        [969, 'RapierMelee', '', 'Dagger Melee', 'Physical', '0,5', 0, '', 0, 'MeleeCombo'],
        [1184, 'MistWalk10', 'MistWalk', 'Mist Walk', 'Physical', '30', 0, 'Dash to enemies', 0, 'Charge', 'MistWalk'],
        [1185, 'MistWalkClose10', 'MistWalkClose', '', 'Physical', '0', 0, 'Mistwalk combo. [Stats: 0.2x Expertise/s (5s)]', 0, 'PBAoE', 'MistWalk'],
        [8032, 'LegendaryMistWalk', '', 'Mist Walk', '', '0,5', 0, '', 0, 'MeleeCombo', 'SwordMelee']
    ],
    abilities: { PoisonStrike: ['Rogue', 'Assault', 1, 10], FireBolt: ['Mage', 'Fire', 5, 10], PoisonDagger: ['Executioner', 'Assault', 0, 1], MistWalk: ['Executioner', 'Assault', 4, 10] }
};

async function main() {
    console.log('Protocol');

    await check('uint/sint round trip, 0 to 2^30', () => {
        for (const v of [0, 1, 2, 3, 4, 255, 256, 65535, 123456, 2 ** 30 - 1]) {
            const r = new P.BitReader(new BitWriter().uint(v).sint(-v).sint(v).buffer());
            assert.strictEqual(r.uint(), v);
            assert.strictEqual(r.sint(), -v || 0);
            assert.strictEqual(r.sint(), v);
        }
    });

    const serverBitBuffer = process.env.DBDPS_SERVER_BITBUFFER;
    if (serverBitBuffer && fs.existsSync(serverBitBuffer)) {
        await check("hit and DoT payloads match the server's own encoder byte for byte", () => {
            const { BitBuffer } = require(serverBitBuffer);
            const bb = new BitBuffer(false);
            bb.writeMethod4(77); bb.writeMethod4(12); bb.writeMethod24(98765); bb.writeMethod4(993);
            bb.writeMethod15(false); bb.writeMethod15(false); bb.writeMethod15(true);
            assert.ok(bb.toBuffer().equals(pkt.hit(77, 12, 98765, 993, true).subarray(4)));
            const d = new BitBuffer(false);
            d.writeMethod4(77); d.writeMethod4(12); d.writeMethod4(993); d.writeMethod45(-4321); d.writeMethod20 ? d.writeMethod20(5, 0) : d.writeMethod11(0, 5);
            assert.ok(d.toBuffer().equals(pkt.dot(77, 12, 993, -4321).subarray(4)));
        });
    }

    await check('0x0A hit decodes target, source, damage, power, crit', () => {
        const h = P.parsePowerHit(pkt.hit(301, 12, 48211, 993, true).subarray(4));
        assert.deepStrictEqual(h, { targetId: 301, sourceId: 12, damage: 48211, powerId: 993, animOverrideId: 0, effectOverrideId: 0, isCrit: true });
    });

    await check('0x08 own body and summon', () => {
        const a = P.parseEntityFullUpdate(pkt.fullUpdate(12, 'ksq', { isPlayer: true }).subarray(4));
        assert.strictEqual(a.isPlayer, true);
        assert.strictEqual(a.name, 'ksq');
        const b = P.parseEntityFullUpdate(pkt.fullUpdate(40, 'NecroSkeleton', { team: 1, summoner: 12, power: 4000 }).subarray(4));
        assert.strictEqual(b.summonerId, 12);
        assert.strictEqual(b.powerId, 4000);
    });

    await check('0x0F, 0x21 and 0x79', () => {
        const e = P.parseNewlyRelevantEntity(pkt.spawn(301, 'GoblinBrute', false, 2).subarray(4));
        assert.deepStrictEqual([e.id, e.name, e.isPlayer, e.team], [301, 'GoblinBrute', false, 2]);
        const w = P.parseEnterWorld(pkt.enterWorld('dungeonblitzr.theminesa.studio', 8080, 'CraftTown').subarray(4));
        assert.deepStrictEqual([w.host, w.port, w.level, w.mapLevel], ['dungeonblitzr.theminesa.studio', 8080, 'CraftTown', 50]);
        const d = P.parseBuffTickDot(pkt.dot(301, 12, 993, 1500).subarray(4));
        assert.deepStrictEqual([d.targetId, d.sourceId, d.powerId, d.amount], [301, 12, 993, 1500]);
    });

    await check('0x21 rewrite: new host and port, every other field kept', () => {
        for (const [host, port] of [['127.0.0.1', 13690], ['a-much-longer-host-name.example.org', 3], ['h', 65535]]) {
            const orig = pkt.enterWorld('dungeonblitzr.theminesa.studio', 8080, 'GoblinRiver').subarray(4);
            const r = P.rewriteEnterWorld(orig, host, port);
            assert.deepStrictEqual([r.host, r.port], ['dungeonblitzr.theminesa.studio', 8080]);
            const a = P.parseEnterWorld(orig);
            const b = P.parseEnterWorld(r.payload);
            assert.deepStrictEqual([b.host, b.port], [host, port]);
            assert.deepStrictEqual([b.swf, b.mapLevel, b.baseLevel, b.level, b.alter, b.isDungeon], [a.swf, a.mapLevel, a.baseLevel, a.level, a.alter, a.isDungeon]);
            const back = P.rewriteEnterWorld(r.payload, a.host, a.port).payload;
            assert.ok(back.subarray(0, orig.length).equals(orig), 'rewriting back gives the original bits');
            assert.ok(back.subarray(orig.length).every((x) => x === 0), 'plus zero padding at most');
        }
        const w = new P.BitWriter();
        for (const v of [0, 1, 3, 4, 255, 8080, 2 ** 30 - 1]) w.uint(v);
        const r = new P.BitReader(w.toBuffer());
        for (const v of [0, 1, 3, 4, 255, 8080, 2 ** 30 - 1]) assert.strictEqual(r.uint(), v);
        const t = new BitWriter();
        for (const v of [0, 1, 3, 4, 255, 8080]) t.uint(v);
        const w2 = new P.BitWriter();
        for (const v of [0, 1, 3, 4, 255, 8080]) w2.uint(v);
        assert.ok(w2.toBuffer().equals(t.buffer()), "the writer picks the client's widths");
    });

    await check('splitter: any chunking, policy exchange skipped, bad packet ignored', () => {
        const stream = Buffer.concat([
            Buffer.from('<policy-file-request/>\0'),
            pkt.hit(1, 2, 3, 4, false),
            frame(0x0a, Buffer.from([0xff])), // truncated payload: unreadable, must not stop the rest
            pkt.cast(2, 993),
            pkt.dot(5, 2, 993, 77)
        ]);
        for (let size = 1; size <= stream.length; size += 3) {
            const got = [];
            const s = new P.PacketSplitter((id) => got.push(id));
            for (let i = 0; i < stream.length; i += size) s.push(stream.subarray(i, i + size));
            assert.deepStrictEqual(got, [0x0a, 0x0a, 0x09, 0x79]);
        }
    });

    console.log('Powers');
    const table = new PowerTable(POWER_DATA);
    await check('names, ranks and scaling from the Stats line', () => {
        const p = table.get(993);
        assert.deepStrictEqual([p.group, p.rank, p.label], ['PoisonStrike', 10, 'Poison Strike']);
        assert.strictEqual(table.statFor(993, 'hit'), 'attack');
        assert.strictEqual(table.statFor(993, 'dot'), 'expertise');
        assert.strictEqual(table.get(984).scaling.dot.stat, 'attack', 'only the current rank counts, not "Next rank"');
        assert.strictEqual(table.statFor(984, 'dot'), 'expertise', 'every DoT tick scales with Expertise');
        assert.strictEqual(table.statFor(3, 'dot'), 'expertise');
        assert.strictEqual(table.statFor(500, 'hit'), 'attack', 'a Fire spell hit is Attack too: BaseDamageMult x meleeDamage');
        assert.strictEqual(table.statFor(3, 'hit'), 'attack');
        assert.strictEqual(table.statFor(500, 'dot'), 'expertise');
        assert.strictEqual(parseScaling('[Stats: 3x heal]').heal, true);
    });

    await check('bundled snapshot of the live game data', () => {
        const data = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'src', 'dps', 'powers-snapshot.json'), 'utf8'));
        const t = new PowerTable(data);
        assert.ok(t.size > 2000);
        const p = t.get(993);
        assert.strictEqual(p.label, 'Poison Strike');
        assert.strictEqual(p.rank, 10);
        assert.strictEqual(p.scaling.hit.mult, 1.49);
        assert.strictEqual(p.scaling.dot.stat, 'expertise');
    });

    console.log('Tracker');
    await check('only the own body and its summons count; friendly targets and heals ignored', () => {
        const t = new CombatTracker('t');
        const dmg = [];
        const casts = [];
        t.on('damage', (e) => dmg.push(e));
        t.on('cast', (e) => casts.push(e));
        const feed = (buf, dir) => (dir === 'down' ? t.fromServer(buf[0] * 256 + buf[1], buf.subarray(4)) : t.fromClient(buf[0] * 256 + buf[1], buf.subarray(4)));
        feed(pkt.fullUpdate(12, 'ksq', { isPlayer: true }));
        feed(pkt.fullUpdate(40, 'NecroSkeleton', { summoner: 12, power: 4000 }));
        feed(pkt.spawn(301, 'GoblinBrute', false, 2), 'down');
        feed(pkt.spawn(77, 'MediaTek', true, 1), 'down');
        feed(pkt.cast(12, 993));
        feed(pkt.cast(301, 5)); // a mob this client owns casting
        feed(pkt.hit(301, 12, 1000, 993, false));
        feed(pkt.hit(301, 40, 300, 4000, false)); // summon
        feed(pkt.hit(12, 301, 999, 5, false)); // mob hits us
        feed(pkt.hit(77, 12, 50, 993, false)); // party member
        feed(pkt.hit(12, 12, -400, 993, false)); // heal on self
        feed(pkt.dot(301, 12, 993, 200));
        feed(pkt.dot(301, 12, 993, 200), 'down'); // server echo of the same tick: skipped
        feed(pkt.dot(302, 12, 993, 150), 'down'); // tick run by another client: counted
        assert.strictEqual(casts.length, 1);
        assert.deepStrictEqual(dmg.map((d) => [d.kind, d.damage, d.powerId, d.targetName]), [
            ['hit', 1000, 993, 'GoblinBrute'],
            ['hit', 300, 4000, 'GoblinBrute'],
            ['dot', 200, 993, 'GoblinBrute'],
            ['dot', 150, 993, '']
        ]);
        assert.strictEqual(dmg[1].summon.name, 'NecroSkeleton');
    });

    console.log('Meter');
    await check('timer, totals, DPS, per spell, scaling split, crits, casts', () => {
        let now = 1000000;
        const m = new DpsMeter({ powers: table, now: () => now });
        m.recordDamage({ kind: 'hit', powerId: 993, damage: 500 });
        assert.strictEqual(m.snapshot().ignored.hits, 1, 'not counted before Start');
        m.start();
        m.recordCast({ powerId: 993 });
        m.recordDamage({ kind: 'hit', powerId: 993, damage: 1000, crit: true, targetName: 'Goblin' });
        now += 2000;
        m.recordDamage({ kind: 'dot', powerId: 993, damage: 400, targetName: 'Goblin' });
        m.recordCast({ powerId: 3 });
        m.recordDamage({ kind: 'hit', powerId: 3, damage: 600 });
        now += 2000;
        m.stop();
        now += 5000; // stopped: time doesn't count
        m.recordDamage({ kind: 'hit', powerId: 3, damage: 999 });
        const s = m.snapshot();
        assert.strictEqual(s.elapsedMs, 4000);
        assert.strictEqual(s.totals.damage, 2000);
        assert.strictEqual(s.dps, 500);
        assert.strictEqual(s.totals.casts, 2);
        assert.strictEqual(s.totals.hits, 2);
        assert.strictEqual(s.totals.crits, 1);
        assert.deepStrictEqual(s.byStat, { attack: 1600, expertise: 400, unknown: 0 });
        const ps = s.equipped.concat(s.others).find((r) => r.key === 'PoisonStrike');
        assert.deepStrictEqual([ps.damage, ps.casts, ps.hits, ps.dotDamage, ps.rank, ps.critRate, ps.share], [1400, 1, 1, 400, 10, 1, 0.7]);
        assert.strictEqual(s.ignored.hits, 2);
        m.start(); // resume
        now += 1000;
        assert.strictEqual(m.snapshot().elapsedMs, 5000);
        m.reset();
        assert.strictEqual(m.snapshot().totals.damage, 0);
        assert.strictEqual(m.state, 'idle');
    });

    await check('auto-start on first hit; first second never divides by less than 1 s', () => {
        let now = 0;
        const m = new DpsMeter({ powers: table, now: () => now });
        m.autoStart = true;
        m.recordCast({ powerId: 993 });
        assert.strictEqual(m.state, 'idle');
        m.recordDamage({ kind: 'hit', powerId: 993, damage: 5000 });
        now += 100;
        const s = m.snapshot();
        assert.strictEqual(s.state, 'running');
        assert.strictEqual(s.dps, 5000);
    });

    await check('equipped spells from a scan come first, in hotbar order', () => {
        const m = new DpsMeter({ powers: table, now: () => 0 });
        m.setSpellScan({ abilities: [{ key: 'PoisonStrike', rank: 10, scalingText: '1.49x attack, 2x Expertise/s (5s)' }], hotbar: [{ key: 'PoisonStrike', slotKey: '1', name: 'Poison Strike', rank: 10 }, { key: 'Evade', slotKey: 'E', name: 'Evade', rank: 3 }] });
        const s = m.snapshot();
        assert.deepStrictEqual(s.equipped.map((r) => [r.key, r.hotkey, r.rank]), [['PoisonStrike', '1', 10], ['Evade', 'E', 3]]);
        assert.strictEqual(s.equipped[0].scaling, '1.49x attack, 2x Expertise/s (5s)');
    });

    await check('DPS over time: buckets of the whole fight and the running average', () => {
        let now = 0;
        const m = new DpsMeter({ powers: table, now: () => now });
        m.start();
        for (let sec = 0; sec < 200; sec++) {
            now = sec * 1000 + 500;
            m.recordDamage({ kind: 'hit', powerId: 3, damage: sec < 100 ? 1000 : 3000 });
        }
        now = 200000;
        m.stop();
        const g = m.snapshot().dpsSeries;
        assert.strictEqual(g.bucketSec, 3, '200 s in at most 90 points');
        assert.strictEqual(g.perSecond.length, 67);
        assert.strictEqual(g.perSecond[0], 1000);
        assert.strictEqual(g.perSecond[66], 3000);
        assert.strictEqual(g.perSecond[34], 2600, 'seconds 102-104: 5-second windows of 2200, 2600 and 3000');
        assert.strictEqual(g.running[66], 2000, 'the last running value is the fight DPS');
        assert.strictEqual(g.peak, 3000);
    });

    await check('basic attacks: melee or ranged from the power\'s TargetMethod, whatever the combo field says', () => {
        let now = 0;
        const m = new DpsMeter({ powers: table, now: () => now });
        assert.strictEqual(m.castKind(1094, { isMelee: true, id: 1 }, false), 'ranged', 'Bone Daggers are thrown');
        assert.strictEqual(m.castKind(1094, null, false), 'ranged');
        assert.strictEqual(m.castKind(969, { isMelee: false, id: 1 }, true), 'melee');
        assert.strictEqual(m.castKind(993, null, false), 'spell');
        m.start();
        m.recordCast({ powerId: 969, combo: { isMelee: true, id: 1 } });
        m.recordDamage({ kind: 'hit', powerId: 969, damage: 10 });
        m.recordCast({ powerId: 1094, combo: { isMelee: true, id: 1 } });
        m.recordDamage({ kind: 'hit', powerId: 1094, damage: 10 });
        m.recordCast({ powerId: 1094, combo: { isMelee: true, id: 2 } });
        m.recordDamage({ kind: 'hit', powerId: 1094, damage: 10 });
        m.recordDamage({ kind: 'dot', powerId: 1094, damage: 5 });
        assert.strictEqual(m.snapshot().rotation.text, 'MA1 RA2');
    });

    await check('a skill\'s follow-up powers and legendary rune count for the skill, as one cast', () => {
        let now = 0;
        const m = new DpsMeter({ powers: table, now: () => now });
        m.start();
        m.recordCast({ powerId: 1184 }); // Mist Walk: the dash does no damage itself
        now = 700;
        m.recordCast({ powerId: 1185 }); // its closing strike, cast by the game
        m.recordDamage({ kind: 'dot', powerId: 1185, damage: 400 });
        m.recordDamage({ kind: 'dot', powerId: 8032, damage: 100 }); // the Bleed a legendary rune adds
        m.recordCast({ powerId: 969, combo: { isMelee: true, id: 1 } });
        m.recordDamage({ kind: 'hit', powerId: 969, damage: 50 });
        const s = m.snapshot();
        const rows = s.equipped.concat(s.others);
        const mw = rows.find((r) => r.key === 'MistWalk');
        assert.deepStrictEqual([mw.label, mw.casts, mw.damage, mw.dotDamage, mw.slot], ['Mist Walk', 1, 500, 500, 4]);
        assert.ok(!rows.some((r) => /Mist Walk/.test(r.label) && r.key !== 'MistWalk'), 'no separate Mist Walk rows under other damage');
        assert.strictEqual(s.totals.casts, 2, 'the follow-up is not another cast');
        assert.strictEqual(s.rotation.text, 's4 MA1');
        assert.strictEqual(s.rotation.entries[0].damage, 500);
    });

    console.log('Spells by the game rules');
    {
        const live = new PowerTable(JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'src', 'dps', 'powers-snapshot.json'), 'utf8')));
        const id = (name) => {
            for (const p of live.byId.values()) if (p.name === name) return p.id;
            throw new Error('no power ' + name);
        };
        const fight = () => {
            let now = 0;
            const m = new DpsMeter({ powers: live, now: () => now });
            m.start();
            return { m, tick: (ms) => (now += ms || 100) };
        };
        const rowsOf = (s) => s.equipped.concat(s.others);
        const row = (s, label) => rowsOf(s).find((r) => r.label === label);
        const otherLabels = (s) => s.others.map((r) => r.label);

        await check("Viperblade: ProcCriticalHit is Charon's Blades, on the hotbar; Crimson Butterfly in Charon's form stays Crimson", () => {
            const { m, tick } = fight();
            const proc = id('ProcCriticalHit');
            m.recordCast({ powerId: id('SeekingBlades10') });
            tick();
            m.recordCast({ powerId: id('SeekingBladesAttack10') }); // its opening attack: part of the cast
            m.recordDamage({ kind: 'hit', powerId: proc, originId: id('SeekingBladesAttack10'), damage: 9000, crit: true });
            tick();
            m.recordCast({ powerId: id('RapierMelee'), combo: { isMelee: true, id: 1 } });
            m.recordDamage({ kind: 'hit', powerId: proc, originId: id('RapierMelee'), damage: 4000, crit: true });
            tick();
            m.recordCast({ powerId: id('ShadowBlade10') });
            m.recordDamage({ kind: 'hit', powerId: proc, originId: id('ShadowBlade10'), damage: 20000, crit: true });
            m.recordDamage({ kind: 'hit', powerId: proc, originId: id('ShadowBlade10'), damage: 21000, crit: true });
            tick();
            m.recordDamage({ kind: 'hit', powerId: proc, damage: 1000 }); // no origin: still Charon's
            m.recordCast({ powerId: id('EndSeekingBlades') });
            const s = m.snapshot();
            const charon = row(s, "Charon's Blades");
            const crimson = row(s, 'Crimson Butterfly');
            assert.deepStrictEqual([charon.damage, charon.casts, charon.hits, charon.slot], [14000, 1, 3, 6]);
            assert.deepStrictEqual([crimson.damage, crimson.casts, crimson.hits, crimson.slot], [41000, 1, 2, 5]);
            assert.ok(s.equipped.includes(charon) && s.equipped.includes(crimson), 'both on the hotbar');
            assert.deepStrictEqual(otherLabels(s), [], 'no Proc Critical Hit under Other damage');
            assert.strictEqual(s.totals.casts, 3, 'Charon, the melee attack and Crimson; its opening attack and its end are not casts');
            assert.strictEqual(s.rotation.text, 's6 MA1 s5', 'the melee hit in Charon form counts for its MA run');
            assert.deepStrictEqual(s.byStat, { attack: 55000, expertise: 0, unknown: 0 });
        });

        await check('Devour and Shadow Scythe: no MonsterProc row, no extra cast; Black Miasma: no empty Shadow Tendril', () => {
            const { m, tick } = fight();
            m.recordCast({ powerId: id('Devour10') });
            m.recordCast({ powerId: id('ProcDevour') }); // its heal, fired by the client
            m.recordDamage({ kind: 'hit', powerId: id('Devour10'), damage: 5000 });
            tick();
            m.recordCast({ powerId: id('Reaper') });
            m.recordCast({ powerId: id('ProcDevour') });
            m.recordDamage({ kind: 'hit', powerId: id('Reaper'), damage: 3000 });
            tick();
            m.recordCast({ powerId: id('ShadowTendrilDash10') });
            m.recordCast({ powerId: id('ShadowTendril10') }); // the cloud it leaves: part of the cast, no damage
            m.recordDamage({ kind: 'hit', powerId: id('ShadowTendrilDash10'), damage: 2000 });
            const s = m.snapshot();
            assert.deepStrictEqual(otherLabels(s), []);
            assert.deepStrictEqual(['Devour', 'Shadow Scythe', 'Black Miasma'].map((l) => row(s, l).casts), [1, 1, 1]);
            assert.strictEqual(s.totals.casts, 3);
            assert.strictEqual(s.rotation.text.split(' ').length, 3);
        });

        await check("Shadow Legion: its clones' Sword Melee and monster attacks count for Shadow Legion; your own melee is \"Melee\"", () => {
            const { m, tick } = fight();
            const legion = id('ShadowLegion10');
            m.recordCast({ powerId: legion });
            tick();
            const clone = (n) => ({ name: 'ShadowLegionClone' + n + '10', powerId: legion });
            m.recordDamage({ kind: 'hit', powerId: id('SwordMelee'), damage: 1500, summon: clone('') });
            m.recordDamage({ kind: 'hit', powerId: id('SkeletonCyclone'), damage: 700, summon: clone('Two') });
            // A clone the 0x08 didn't name a power for: found by its entity type.
            m.recordDamage({ kind: 'hit', powerId: id('FalseTendrilDash'), damage: 800, summon: { name: 'ShadowLegionCloneThree10', powerId: 0 } });
            m.recordDamage({ kind: 'hit', powerId: id('ShadowLegionExplode10'), damage: 6000, summon: clone('') });
            tick();
            m.recordCast({ powerId: id('RapierMelee'), combo: { isMelee: true, id: 1 } });
            m.recordDamage({ kind: 'hit', powerId: id('RapierMelee'), damage: 900 });
            const s = m.snapshot();
            const sl = row(s, 'Shadow Legion');
            assert.deepStrictEqual([sl.damage, sl.hits, sl.summonDamage, sl.casts, sl.slot], [9000, 4, 9000, 1, 5]);
            assert.deepStrictEqual(otherLabels(s), ['Melee'], 'no Sword Melee or Monster rows; Dagger Melee reads Melee');
            assert.strictEqual(row(s, 'Melee').damage, 900);
            assert.strictEqual(s.rotation.entries[0].damage, 9000, "the clones' damage goes to the Shadow Legion cast");
        });

        await check('the mount is never part of the fight: Summon Mount and Dismount', () => {
            const { m, tick } = fight();
            m.recordCast({ powerId: id('RapierMelee'), combo: { isMelee: true, id: 1 } });
            m.recordDamage({ kind: 'hit', powerId: id('RapierMelee'), damage: 100 });
            tick();
            m.recordCast({ powerId: id('SummonMount') });
            m.recordCast({ powerId: id('Dismount') });
            m.recordCast({ powerId: id('RapierMelee'), combo: { isMelee: true, id: 2 } });
            m.recordDamage({ kind: 'hit', powerId: id('RapierMelee'), damage: 100 });
            const s = m.snapshot();
            assert.ok(!rowsOf(s).some((r) => /Wolf Bear|Dismount|Mount/.test(r.label)));
            assert.strictEqual(s.totals.casts, 2);
            assert.strictEqual(s.rotation.text, 'MA2', 'the melee run goes on across it');
        });

        await check('Frostbringer: Frost Armor powers and End Hailstone Embrace are Hailstone Embrace; its basic attacks stay MA and RA', () => {
            const { m, tick } = fight();
            const hail = id('HailstoneEmbrace10');
            m.recordCast({ powerId: hail });
            tick();
            m.recordCast({ powerId: id('FrostArmorRanged10'), combo: { isMelee: false, id: 1 } });
            m.recordDamage({ kind: 'hit', powerId: id('FrostArmorIce10'), damage: 3000 }); // the ice it leaves
            m.recordDamage({ kind: 'hit', powerId: id('FrostArmorIce10'), damage: 3000 });
            tick();
            m.recordCast({ powerId: id('FrostArmorRanged10'), combo: { isMelee: false, id: 2 } });
            m.recordDamage({ kind: 'hit', powerId: id('FrostArmorIce10'), damage: 3000 });
            tick();
            m.recordCast({ powerId: id('FrostArmorMelee9'), combo: { isMelee: true, id: 1 } });
            m.recordDamage({ kind: 'hit', powerId: id('FrostArmorMelee9'), damage: 5000 });
            m.recordDamage({ kind: 'dot', powerId: id('FrostArmorMelee9'), damage: 200 });
            tick();
            m.recordCast({ powerId: id('EndFrostArmor') });
            const s = m.snapshot();
            const he = row(s, 'Hailstone Embrace');
            assert.deepStrictEqual([he.damage, he.casts, he.hits, he.dotDamage, he.slot], [14200, 1, 4, 200, 6]);
            assert.deepStrictEqual(otherLabels(s), [], 'no Frost Armor rows, no End Hailstone Embrace');
            assert.strictEqual(s.rotation.text, 's6 RA3 MA1');
            assert.strictEqual(s.totals.casts, 4);
            assert.deepStrictEqual(he.byStat, { attack: 14000, expertise: 200, unknown: 0 });
        });

        await check('Frostbringer scaling: Bitter Blade, Frozen Ward and Frigid Comet hit with Attack; Chilblains ticks from Frigid Comet are Expertise, in Frigid Comet', () => {
            const { m } = fight();
            m.recordDamage({ kind: 'hit', powerId: id('BitterBlade10'), damage: 4000 });
            m.recordDamage({ kind: 'hit', powerId: id('FrozenWard10'), damage: 3000 });
            m.recordDamage({ kind: 'hit', powerId: id('FrigidComet10'), damage: 8000 });
            // Chilblains: AddBuff(Chilblains, caster, caster.magicDamage, FrigidComet's powerID)
            m.recordDamage({ kind: 'dot', powerId: id('FrigidComet10'), damage: 600 });
            const s = m.snapshot();
            assert.deepStrictEqual(row(s, 'Bitter Blade').byStat, { attack: 4000, expertise: 0, unknown: 0 });
            assert.deepStrictEqual(row(s, 'Frozen Ward').byStat, { attack: 3000, expertise: 0, unknown: 0 });
            const fc = row(s, 'Frigid Comet');
            assert.deepStrictEqual([fc.damage, fc.dotDamage, fc.byStat.attack, fc.byStat.expertise], [8600, 600, 8000, 600]);
        });

        await check('a glancing blow counts for the power that hit; other damage lists only rows with damage', () => {
            const { m } = fight();
            m.recordCast({ powerId: id('ShadowBlade10') });
            m.recordDamage({ kind: 'hit', powerId: id('ProcGlancingBlow'), originId: id('ShadowBlade10'), damage: 500 });
            m.recordCast({ powerId: id('PetCrow') }); // a cast that never dealt damage
            const s = m.snapshot();
            assert.strictEqual(row(s, 'Crimson Butterfly').damage, 500);
            assert.deepStrictEqual(otherLabels(s), []);
        });

        await check('the relay hands the meter the power a proc came from', () => {
            const t = new CombatTracker('test');
            const seen = [];
            t.on('damage', (d) => seen.push(d));
            t.fromClient(0x08, pkt.fullUpdate(12, 'ksq', { isPlayer: true }).subarray(4));
            t.fromClient(0x0a, pkt.procHit(301, 12, 25000, 1447, 1139, true).subarray(4));
            t.fromClient(0x0a, pkt.hit(301, 12, 900, 969, false).subarray(4));
            assert.deepStrictEqual(seen.map((d) => [d.powerId, d.originId]), [[1447, 1139], [969, undefined]]);
        });
    }

    console.log('Dungeon mode');
    {
        const live = new PowerTable(JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'src', 'dps', 'powers-snapshot.json'), 'utf8')));
        const make = () => {
            let now = 100000;
            const m = new DpsMeter({ powers: live, now: () => now });
            m.setDungeonMode(true);
            m.noteLevel('GoblinRiverDungeon');
            return { m, at: (ms) => (now = 100000 + ms), hit: (dmg) => m.recordDamage({ kind: 'hit', powerId: 969, damage: dmg || 1000, targetName: 'Goblin' }) };
        };
        const D = (m) => m.snapshot().dungeon;

        await check('first hit starts; 3 s without damage pauses at the last hit; the next hit carries on', () => {
            const { m, at, hit } = make();
            assert.deepStrictEqual([D(m).phase, D(m).levelName, D(m).isDungeon], ['waiting', 'Goblin Camp', true]);
            at(0);
            m.recordCast({ powerId: 969, combo: { isMelee: true, id: 1 } }); // a cast alone doesn't start it
            assert.strictEqual(m.state, 'idle');
            at(1000);
            hit();
            assert.strictEqual(m.state, 'running');
            at(2500);
            m.recordDamage({ kind: 'dot', powerId: 969, damage: 300 }); // damage over time keeps it going
            at(5400);
            m.tick();
            assert.strictEqual(m.state, 'running', '2.9 s after the last damage');
            at(5600);
            m.tick();
            assert.deepStrictEqual([m.state, D(m).phase, D(m).reason], ['stopped', 'paused', 'idle']);
            assert.strictEqual(m.snapshot().elapsedMs, 1500, 'the clock stops at the last damage, not 3 s later');
            at(20000);
            hit(); // the next pack
            assert.deepStrictEqual([m.state, D(m).phase], ['running', 'running']);
            at(21000);
            assert.strictEqual(m.snapshot().elapsedMs, 2500);
            assert.strictEqual(m.snapshot().totals.damage, 2300);
            assert.strictEqual(D(m).idlePauses, 1);
        });

        await check('dying pauses; nothing counts until you are back; revive, a cast or your own hit brings you back', () => {
            const { m, at, hit } = make();
            at(0);
            hit();
            at(800);
            hit();
            at(1000);
            m.playerDied();
            assert.deepStrictEqual([m.state, D(m).reason, D(m).deaths, m.snapshot().elapsedMs], ['stopped', 'dead', 1, 800]);
            at(2000);
            m.recordDamage({ kind: 'dot', powerId: 969, damage: 500 }); // a tick while you're dead
            assert.deepStrictEqual([m.state, m.snapshot().totals.damage, m.snapshot().ignored.damage], ['stopped', 2000, 500]);
            at(9000);
            m.playerRevived();
            assert.strictEqual(D(m).reason, 'revived');
            at(9500);
            hit();
            assert.strictEqual(m.state, 'running');
            // A missed revive: casting means you're alive.
            m.playerDied();
            m.recordCast({ powerId: 969, combo: { isMelee: true, id: 1 } });
            assert.strictEqual(D(m).playerDead, false);
            at(9700);
            hit();
            assert.strictEqual(m.state, 'running');
        });

        await check('a boss pauses; the Level Complete right after ends the run as "boss"; later hits do not count', () => {
            const { m, at, hit } = make();
            at(0);
            hit();
            at(4000);
            hit(50000);
            at(4060);
            m.bossDied('Tak-Ugo'); // the first of two bosses: a pause, not the end
            assert.deepStrictEqual([m.state, D(m).phase, D(m).reason, m.snapshot().elapsedMs], ['stopped', 'paused', 'boss', 4000]);
            at(30000);
            hit();
            at(61000);
            hit(80000);
            m.levelProgress(87);
            at(61050);
            m.bossDied('Tak-Ogg');
            at(61300);
            m.levelComplete();
            const d = D(m);
            assert.deepStrictEqual([m.state, d.phase, d.endedBy, d.completion], ['stopped', 'ended', 'boss', 87]);
            assert.deepStrictEqual(d.bosses.map((b) => b.name), ['Tak-Ugo', 'Tak-Ogg']);
            assert.strictEqual(m.snapshot().elapsedMs, 4000 + 31000);
            at(62000);
            hit(); // the leftovers
            assert.deepStrictEqual([m.state, m.snapshot().ignored.hits], ['stopped', 1]);
            m.tick();
            assert.strictEqual(D(m).phase, 'ended');
        });

        await check('100% completion ends the run as "cleared"; the next dungeon starts a new run on its first hit', () => {
            const { m, at, hit } = make();
            at(0);
            hit(7000);
            at(1000);
            m.levelProgress(100);
            assert.deepStrictEqual([D(m).phase, D(m).endedBy, m.snapshot().elapsedMs], ['ended', 'cleared', 0]);
            m.levelComplete(); // arrives after: already ended
            assert.strictEqual(D(m).endedBy, 'cleared');
            m.noteLevel('CraftTown'); // town: results stay
            at(60000);
            hit();
            assert.deepStrictEqual([m.state, m.snapshot().totals.damage], ['stopped', 7000]);
            m.noteLevel('SRN_Mission1'); // the next dungeon
            assert.strictEqual(D(m).nextRunPending, true);
            assert.strictEqual(m.snapshot().totals.damage, 7000, 'the finished run stays until the first hit there');
            at(90000);
            hit(1234);
            const d = D(m);
            assert.deepStrictEqual([m.state, d.phase, d.runLevelName, m.snapshot().totals.damage], ['running', 'running', 'Tower of the Tuatara', 1234]);
        });

        await check('leaving the dungeon ends the run; Stop ends it, Start carries it on', () => {
            const { m, at, hit } = make();
            at(0);
            hit();
            at(1000);
            m.stop();
            assert.deepStrictEqual([D(m).phase, D(m).endedBy], ['ended', 'manual']);
            at(2000);
            hit();
            assert.strictEqual(m.state, 'stopped', 'a stopped run stays stopped');
            m.start();
            assert.deepStrictEqual([m.state, D(m).phase], ['running', 'running']);
            at(2500);
            hit();
            at(3000);
            m.noteLevel('CraftTown');
            assert.deepStrictEqual([D(m).phase, D(m).endedBy, m.snapshot().elapsedMs], ['ended', 'left', 1500]);
            m.setDungeonMode(false);
            assert.strictEqual(m.snapshot().dungeon, null);
        });

        const id = (name) => {
            for (const p of live.byId.values()) if (p.name === name) return p.id;
            throw new Error('no power ' + name);
        };
        const melee = (m) => m.recordCast({ powerId: 969, combo: { isMelee: true, id: 1 } });
        const R = (m) => m.report().rotation.map((e) => [e.badge, e.t, e.times.join('/'), e.damage]);

        await check('the cast whose hit starts or restarts the clock is in the rotation, at that moment', () => {
            const { m, at, hit } = make();
            at(0);
            melee(m); // before the first hit, while the clock waits
            at(300);
            hit(); // its hit starts the clock
            at(800);
            melee(m);
            at(1000);
            hit();
            at(4100);
            m.tick(); // paused at 0.7 s
            at(9000);
            m.recordCast({ powerId: id('MistWalk10') }); // walking to the next pack, 11 s before its first hit
            at(19400);
            m.recordCast({ powerId: id('ShadowBlade10') });
            at(20000);
            m.recordDamage({ kind: 'hit', powerId: id('ShadowBlade10'), damage: 5000, targetName: 'Goblin' });
            at(20200);
            melee(m);
            at(20400);
            hit();
            at(24000);
            m.tick(); // paused at 1.1 s
            at(30000);
            melee(m);
            at(30250);
            hit();
            assert.deepStrictEqual(R(m), [
                ['MA2', 0, '0/500', 2000],
                ['s5', 700, '700', 5000],
                ['MA1', 900, '900', 1000],
                ['MA1', 1100, '1100', 1000]
            ], 'a run of basic attacks ends when the clock stops');
            const s = m.snapshot();
            assert.deepStrictEqual([s.totals.casts, s.ignored.casts], [5, 1], 'only the Mist Walk long before is left out');
            const j = exporter.toJson(m.report(), { source: 'test' });
            assert.deepStrictEqual(j.rotation.casts.map((c) => c.castTimesMs), [[0, 500], [700], [900], [1100]]);
            assert.strictEqual(j.rotation.text, 'MA2 s5 MA1 MA1');
        });

        await check('a cast whose hit took longer than 3 s to land still counts, with everything cast after it', () => {
            const { m, at, hit } = make();
            const legion = id('ShadowLegion10');
            at(0);
            hit();
            at(3100);
            m.tick(); // paused at 0
            at(10000);
            m.recordCast({ powerId: id('MistWalk10') }); // before the summon: not part of it
            at(11000);
            m.recordCast({ powerId: legion }); // its clones walk to the next pack
            at(12500);
            m.recordCast({ powerId: id('DeathBlowOld10') }); // Assassinate, which misses
            at(16000);
            m.recordDamage({ kind: 'hit', powerId: id('SwordMelee'), damage: 1500, summon: { name: 'ShadowLegionClone10', powerId: legion }, targetName: 'Goblin' });
            assert.deepStrictEqual(R(m), [['s5', 0, '0', 1500], ['s3', 0, '0', 0]]);
            assert.strictEqual(m.snapshot().ignored.casts, 1);
        });

        await check('casts after your last hit, made while the lull is noticed, are timed when the clock stopped', () => {
            const { m, at, hit } = make();
            at(0);
            hit();
            at(1000);
            hit();
            at(2500);
            m.recordCast({ powerId: id('DeathBlowOld10') }); // the pack is dead: it hits nothing
            at(3200);
            melee(m);
            at(4000);
            m.tick();
            assert.strictEqual(m.snapshot().elapsedMs, 1000);
            assert.deepStrictEqual(m.rotation.map((e) => [e.kind, e.t, e.endT, e.times.join('/')]), [['spell', 1000, 1000, '1000'], ['melee', 1000, 1000, '1000']]);
            at(9000);
            melee(m);
            at(9200);
            hit();
            const times = m.rotation.map((e) => e.t);
            assert.deepStrictEqual(times, [1000, 1000, 1000], 'never back in time');
            assert.deepStrictEqual(R(m), [['s3', 1000, '1000', 0], ['MA1', 1000, '1000', 1000]], 'the missed swing before the pause is its own (empty) run');
        });

        await check('the opener of the next dungeon goes into its new run', () => {
            const { m, at, hit } = make();
            at(0);
            hit(7000);
            m.levelProgress(100);
            m.noteLevel('SRN_Mission1');
            at(59500);
            melee(m);
            at(60000);
            hit(1234);
            assert.deepStrictEqual(R(m), [['MA1', 0, '0', 1234]]);
            assert.deepStrictEqual([m.snapshot().totals.casts, m.snapshot().ignored.casts], [1, 0]);
        });

        await check('the relay reports your death and revive, a boss dying, completion and Level Complete', () => {
            const t = new CombatTracker('test');
            const seen = [];
            for (const ev of ['died', 'revived', 'bossDied', 'completion', 'levelComplete']) t.on(ev, (x) => seen.push(ev + (x === undefined ? '' : ' ' + JSON.stringify(x))));
            t.isBoss = (name) => name === 'GoblinBoss1' || name === 'GoblinBoss2';
            const up = (b) => t.fromClient(b.readUInt16BE(0), b.subarray(4));
            const down = (b) => t.fromServer(b.readUInt16BE(0), b.subarray(4));
            up(pkt.fullUpdate(12, 'ksq', { isPlayer: true }));
            up(pkt.move(12, 0));
            up(pkt.move(12, 3));
            up(pkt.move(12, 3));
            up(pkt.move(12, 0));
            // A boss this client runs (solo): its 0x08 names it, its 0x07 says when it dies.
            up(pkt.fullUpdate(700, 'GoblinBoss1', { team: 2 }));
            up(pkt.move(700, 0));
            up(pkt.move(700, 3));
            // A boss another client runs: the server's 0x0f names it, its 0x07 comes back from the server.
            down(pkt.spawn(701, 'GoblinBoss2', false, 2));
            down(pkt.move(701, 0));
            down(pkt.move(701, 3));
            // A boss already dead when first seen, and a monster that isn't a boss.
            down(pkt.spawn(702, 'GoblinBoss2', false, 2));
            down(pkt.move(702, 3));
            down(pkt.spawn(703, 'GoblinGrunt', false, 2));
            down(pkt.move(703, 0));
            down(pkt.move(703, 3));
            up(pkt.completion(63));
            down(pkt.completion(64));
            up(pkt.setLevelComplete(100));
            down(pkt.recvLevelComplete());
            assert.deepStrictEqual(seen, [
                'died',
                'revived',
                'bossDied {"id":700,"name":"GoblinBoss1"}',
                'bossDied {"id":701,"name":"GoblinBoss2"}',
                'completion 63',
                'completion 64',
                'levelComplete {"from":"client"}',
                'levelComplete {"from":"server"}'
            ]);
        });

        await check("bosses from the game's EntTypes, ranks inherited from parents", () => {
            const { parseEntTypes, bossesFromXml, BossTable } = require('../src/dps/entities');
            const xml =
                '<EntTypes><EntType EntName="GoblinBoss1"><DisplayName>Tak-Ugo</DisplayName><EntRank>Boss</EntRank></EntType>' +
                '<EntType EntName="GoblinBoss1Hard" parent="GoblinBoss1"><Level>40</Level></EntType>' +
                '<EntType EntName="GoblinGrunt"><EntRank>Minion</EntRank></EntType></EntTypes>';
            const types = parseEntTypes(xml);
            assert.deepStrictEqual(types.get('GoblinBoss1Hard'), { rank: 'Boss', displayName: 'Tak-Ugo' });
            const b = new BossTable(bossesFromXml(xml));
            assert.deepStrictEqual([b.has('GoblinBoss1Hard'), b.has('GoblinGrunt'), b.displayName('GoblinBoss1Hard')], [true, false, 'Tak-Ugo']);
            const bundled = new BossTable(JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'src', 'dps', 'bosses-snapshot.json'), 'utf8')));
            assert.ok(bundled.size > 200);
            assert.strictEqual(bundled.displayName('BanditBoss'), 'Svagg');
            assert.ok(!bundled.has('HomeDummy1') && !bundled.has('ShadowLegionClone10'));
        });

        await check('the export carries the run', () => {
            const { m, at, hit } = make();
            at(0);
            hit(5000);
            m.levelProgress(100);
            const j = exporter.toJson(m.report(), { source: 'test', character: 'ksq' });
            assert.deepStrictEqual(
                [j.fight.dungeon.level, j.fight.dungeon.name, j.fight.dungeon.completion, j.fight.dungeon.endedBy, j.fight.dungeon.deaths],
                ['GoblinRiverDungeon', 'Goblin Camp', 100, 'cleared', 0]
            );
            assert.ok(exporter.toSummary(m.report(), { character: 'ksq' }).split('\n').includes('Dungeon: Goblin Camp, 100% cleared'));
            assert.ok(/Completion %,100/.test(exporter.toCsv(m.report(), { character: 'ksq' })));
        });
    }

    console.log('Export');
    await check('JSON, CSV and summary agree with the meter', () => {
        let now = 0;
        const m = new DpsMeter({ powers: table, now: () => now });
        m.start();
        m.recordCast({ powerId: 993 });
        m.recordCast({ powerId: 993 });
        m.recordDamage({ kind: 'hit', powerId: 993, damage: 3000, crit: true, targetName: 'Goblin' });
        m.recordDamage({ kind: 'dot', powerId: 993, damage: 1000, targetName: 'Goblin' });
        now = 10000;
        m.stop();
        const meta = { source: 'test', character: 'ksq', className: 'Rogue' };
        const j = exporter.toJson(m.report(), meta);
        assert.deepStrictEqual([j.format, j.version, j.source], ['dbb-dps', 2, 'test']);
        assert.strictEqual(j.fight.damage, 4000);
        assert.strictEqual(j.fight.dps, 400);
        assert.strictEqual(j.fight.casts, 2);
        assert.strictEqual(j.fight.duration, '0:10.0');
        assert.strictEqual(j.spells[0].key, 'PoisonStrike');
        assert.strictEqual(j.spells[0].casts, 2);
        assert.strictEqual(j.distribution.byStat.attack.share, 0.75);
        assert.strictEqual(j.distribution.byKind.dot.damage, 1000);
        assert.deepStrictEqual(j.hits[0], { atMs: 0, powerId: 993, damage: 3000, crit: true, kind: 'hit', target: 'Goblin', summon: null, spell: 'PoisonStrike' });
        assert.deepStrictEqual(j.rotation.steps, ['PoisonStrike', 'PoisonStrike']);
        assert.strictEqual(j.rotation.casts[1].damage, 4000, 'both hits and the tick go to the latest cast of the power');
        const csv = exporter.toCsv(m.report(), meta).split('\r\n');
        assert.ok(csv[0].startsWith('Spell,Rank,Hotbar key,Casts'));
        assert.ok(csv[1].startsWith('Poison Strike,10,1,2,1,1,100,4000,100,400'), csv[1]);
        const sum = exporter.toSummary(m.report(), meta);
        assert.ok(sum.includes('400 DPS, 4,000 damage, 2 casts, 1 hits (100% crit)'), sum);
        assert.ok(sum.includes('1. Poison Strike r10: 4,000 (100%), 2 casts'), sum);
        assert.ok(sum.includes('Rotation: s1 s1'), sum);
    });

    await check('rotation: spells as s<slot>, basic attacks as MA/RA runs counted by hits, DoTs per cast', () => {
        let now = 0;
        const m = new DpsMeter({ powers: table, now: () => now });
        m.start();
        m.recordCast({ powerId: 3, combo: { isMelee: true, id: 1 } });
        m.recordDamage({ kind: 'hit', powerId: 3, damage: 100 });
        now = 400;
        m.recordCast({ powerId: 3, combo: { isMelee: true, id: 2 } });
        m.recordDamage({ kind: 'hit', powerId: 3, damage: 120, crit: true });
        m.recordDamage({ kind: 'hit', powerId: 3, damage: 80 }); // a second target: another reading
        now = 900;
        m.recordCast({ powerId: 993 });
        m.recordDamage({ kind: 'hit', powerId: 993, damage: 3000 });
        m.recordDamage({ kind: 'hit', powerId: 993, damage: 3100 });
        now = 1900;
        m.recordDamage({ kind: 'dot', powerId: 993, damage: 500 });
        m.recordCast({ powerId: 3 }); // no combo field: a basic attack by its power, and it misses
        now = 2000;
        m.recordCast({ powerId: 3, combo: { isMelee: false, id: 1 } }); // ranged: a new run
        m.recordDamage({ kind: 'hit', powerId: 3, damage: 70 });
        m.recordCast({ powerId: 3, combo: { isMelee: false, id: 2 } });
        m.recordDamage({ kind: 'hit', powerId: 3, damage: 75 });
        m.recordCast({ powerId: 4000 }); // a monster power that does nothing: not listed
        now = 2600;
        m.recordCast({ powerId: 500 }); // hotbar slot 5 (E)
        m.recordCast({ powerId: 993 });
        m.recordDamage({ kind: 'dot', powerId: 993, damage: 600 }); // after the recast: the new cast's
        const r = m.snapshot().rotation;
        assert.deepStrictEqual(r.entries.map((e) => e.badge), ['MA3', 's1', 'RA2', 's5', 's1'], 'the missed melee run is left out');
        assert.strictEqual(r.text, 'MA3 s1 RA2 s5 s1');
        assert.deepStrictEqual(r.entries.map((e) => e.damage), [300, 6600, 145, 0, 600]);
        assert.deepStrictEqual(r.entries.map((e) => e.casts), [2, 1, 2, 1, 1]);
        assert.deepStrictEqual([r.entries[1].hits, r.entries[1].dotDamage, r.entries[0].crits], [2, 500, 1]);
        assert.deepStrictEqual(r.entries.map((e) => e.slotKey), ['', '1', '', 'E', '1']);
        assert.strictEqual(r.casts, 7);
        const s = m.snapshot();
        assert.deepStrictEqual(s.equipped.map((v) => [v.key, v.slot, v.hotkey]), [['PoisonStrike', 1, '1'], ['FireBolt', 5, 'E']], 'without a scan, used hotbar spells in slot order');
        const j = exporter.toJson(m.report(), { source: 't' });
        assert.deepStrictEqual(j.rotation.steps, ['basic', 'basic', 'PoisonStrike', 'basic', 'basic', 'FireBolt', 'PoisonStrike']);
        assert.deepStrictEqual(j.rotation.casts.map((c) => c.label), ['MA3', 's1', 'RA2', 's5', 's1']);
        assert.strictEqual(j.rotation.text, 'MA3 s1 RA2 s5 s1');
        assert.deepStrictEqual([j.rotation.casts[0].casts, j.rotation.casts[0].hits, j.rotation.casts[3].slotKey], [2, 3, 'E']);
        assert.deepStrictEqual(j.rotation.casts.map((c) => c.castTimesMs), [[0, 400], [900], [2000, 2000], [2600], [2600]], 'every basic attack has its own time');
        const csv = exporter.toCsv(m.report(), { character: 'ksq' });
        assert.ok(csv.includes('\r\nRotation,Time (s),Shown as,Spell,Kind,Casts,Damage,Direct damage,DoT damage,Hits,Crits,Cast times (s)\r\n'), csv);
        assert.ok(csv.includes('\r\n1,0,MA3,Sword Melee,melee,2,300,300,0,3,1,0 0.4\r\n'), csv);
        assert.ok(csv.includes('\r\n2,0.9,s1,Poison Strike,spell,1,6600,6100,500,2,0,0.9\r\n'), csv);
        assert.ok(exporter.toSummary(m.report(), {}).includes('Rotation: MA3 s1 RA2 s5 s1'));
        const g = m.snapshot().dpsSeries;
        assert.deepStrictEqual([g.bucketSec, g.seconds, g.perSecond.length], [1, 2, 2], 'the second in progress is left out');
        m.reset();
        assert.strictEqual(m.snapshot().rotation.count, 0);
    });

    await check('Start on first hit counts the cast that landed it; Start by hand counts from the click', () => {
        let now = 0;
        const m = new DpsMeter({ powers: table, now: () => now });
        m.autoStart = true;
        m.recordCast({ powerId: 993 });
        now = 400;
        m.recordDamage({ kind: 'hit', powerId: 993, damage: 3000 });
        const r = m.snapshot().rotation;
        assert.deepStrictEqual(r.entries.map((e) => [e.badge, e.t, e.damage]), [['s1', 0, 3000]]);
        assert.deepStrictEqual([m.snapshot().totals.casts, m.snapshot().ignored.casts], [1, 0]);
        const h = new DpsMeter({ powers: table, now: () => now });
        h.recordCast({ powerId: 993 });
        now = 800;
        h.start();
        h.recordDamage({ kind: 'hit', powerId: 993, damage: 3000 });
        assert.strictEqual(h.snapshot().rotation.count, 0, 'a cast before Start is not part of it');
        assert.deepStrictEqual([h.snapshot().totals.casts, h.snapshot().ignored.casts], [0, 1]);
    });

    console.log('Spell scans');
    await check('reads the scanner file format', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dbdps-'));
        const file = path.join(dir, 'DB spells ksq.json');
        fs.writeFileSync(file, '﻿' + JSON.stringify({ format: 'dbb-spells', version: 1, character: { name: 'ksq', class: 'Rogue' }, spells: { scannedAt: '2026-10-06T15:00:00Z', abilities: [{ key: 'PoisonStrike', rank: 10 }], hotbar: [{ key: 'PoisonStrike', slotKey: '1' }] } }));
        const s = readScan(file);
        assert.strictEqual(s.character, 'ksq');
        assert.strictEqual(s.hotbar[0].slotKey, '1');
        fs.writeFileSync(file, JSON.stringify({ format: 'dbb-inventory', version: 1, gear: [] }));
        assert.strictEqual(readScan(file), null, 'a gear-only scan has no spells');
    });

    console.log('Relay');
    await check('bytes pass through unchanged both ways; hits reach the meter', async () => {
        const toServer = [];
        const fromServerScript = Buffer.concat([pkt.spawn(301, 'GoblinBrute', false, 2), pkt.enterWorld('dungeonblitzr.theminesa.studio', 8080, 'GoblinRiver')]);
        const upstream = net.createServer((sock) => {
            sock.on('data', (d) => toServer.push(d));
            // Answer in awkward pieces.
            let i = 0;
            const tick = setInterval(() => {
                if (i >= fromServerScript.length) {
                    clearInterval(tick);
                    return;
                }
                sock.write(fromServerScript.subarray(i, i + 7));
                i += 7;
            }, 2);
        });
        await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
        const relay = new GameRelay({ listenPort: 0, upstreamHost: '127.0.0.1', upstreamPort: upstream.address().port });
        assert.ok(await relay.listen());
        const port = relay.server.address().port;
        const m = new DpsMeter({ powers: table });
        m.start();
        let level = '';
        relay.on('connection', (tr) => {
            tr.on('damage', (e) => m.recordDamage(e));
            tr.on('cast', (e) => m.recordCast(e));
            tr.on('enterWorld', (w) => (level = w.level));
        });
        const client = net.connect(port, '127.0.0.1');
        const received = [];
        client.on('data', (d) => received.push(d));
        await new Promise((r) => client.on('connect', r));
        const clientScript = Buffer.concat([
            pkt.fullUpdate(12, 'ksq', { isPlayer: true }),
            pkt.cast(12, 993),
            pkt.hit(301, 12, 1234, 993, true),
            pkt.dot(301, 12, 993, 66)
        ]);
        for (let i = 0; i < clientScript.length; i += 5) {
            client.write(clientScript.subarray(i, i + 5));
            await new Promise((r) => setTimeout(r, 1));
        }
        await new Promise((r) => setTimeout(r, 300));
        assert.ok(Buffer.concat(toServer).equals(clientScript), 'server got exactly what the client sent');
        assert.ok(Buffer.concat(received).equals(fromServerScript), 'client got exactly what the server sent');
        const s = m.snapshot();
        assert.strictEqual(s.totals.damage, 1300);
        assert.strictEqual(s.totals.casts, 1);
        assert.strictEqual(level, 'GoblinRiver');
        client.destroy();
        await new Promise((r) => setTimeout(r, 50));
        assert.strictEqual(relay.open.size, 0, 'closing the client closes the pair');
        relay.close();
        upstream.close();
    });

    await check('a refused upstream closes the client instead of hanging', async () => {
        const dead = net.createServer();
        await new Promise((r) => dead.listen(0, '127.0.0.1', r));
        const deadPort = dead.address().port;
        await new Promise((r) => dead.close(r));
        const relay = new GameRelay({ listenPort: 0, upstreamHost: '127.0.0.1', upstreamPort: deadPort });
        await relay.listen();
        const client = net.connect(relay.server.address().port, '127.0.0.1');
        await new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('client was left open')), 2000);
            client.on('close', () => {
                clearTimeout(timer);
                resolve();
            });
            client.on('error', () => {});
        });
        relay.close();
    });

    await check("Flash's policy question is answered locally and never reaches the server", async () => {
        let reached = 0;
        const upstream = net.createServer((sock) => {
            reached += 1;
            sock.destroy();
        });
        await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
        const relay = new GameRelay({ listenPort: 0, upstreamHost: '127.0.0.1', upstreamPort: upstream.address().port });
        await relay.listen();
        const answer = await new Promise((resolve) => {
            const c = net.connect(relay.listenPort, '127.0.0.1', () => {
                c.write('<policy-file-');
                setTimeout(() => c.write('request/>\0'), 20);
            });
            const got = [];
            c.on('data', (d) => got.push(d));
            c.on('close', () => resolve(Buffer.concat(got).toString('latin1')));
        });
        assert.strictEqual(answer, POLICY);
        assert.ok(answer.includes('to-ports="*"'));
        assert.strictEqual(reached, 0);
        assert.strictEqual(relay.connections, 0);
        relay.close();
        upstream.close();
    });

    await check('enter world sends the client to a new relay for the next server, which also counts hits', async () => {
        // A login server that sends the client on to a game server, and the game server.
        const gameGot = [];
        const game = net.createServer((sock) => sock.on('data', (d) => gameGot.push(d)));
        await new Promise((r) => game.listen(0, '127.0.0.1', r));
        const gamePort = game.address().port;
        const login = net.createServer((sock) => {
            sock.once('data', () => {
                sock.write(pkt.spawn(301, 'GoblinBrute', false, 2));
                sock.end(pkt.enterWorld('127.0.0.1', gamePort, 'GoblinRiver')); // and hang up, as the server does
            });
        });
        await new Promise((r) => login.listen(0, '127.0.0.1', r));
        const hub = new RelayHub({ portBase: 0 }); // any free ports
        const loginRelay = await hub.relayFor('127.0.0.1', login.address().port);
        const m = new DpsMeter({ powers: table });
        m.start();
        const redirects = [];
        hub.on('connection', (_relay, tr) => tr.on('damage', (e) => m.recordDamage(e)));
        hub.on('redirect', (_relay, info) => redirects.push(info));

        const c1 = net.connect(loginRelay.listenPort, '127.0.0.1');
        const got1 = [];
        c1.on('data', (d) => got1.push(d));
        await new Promise((r) => c1.on('connect', r));
        c1.write(pkt.fullUpdate(12, 'ksq', { isPlayer: true }));
        await new Promise((r) => c1.on('close', r));
        const frames = [];
        new P.PacketSplitter((id, payload) => frames.push([id, payload])).push(Buffer.concat(got1));
        assert.deepStrictEqual(frames.map((f) => f[0]), [0x0f, 0x21], 'both packets arrive, the second after the hang-up');
        const w = P.parseEnterWorld(frames[1][1]);
        assert.strictEqual(w.host, '127.0.0.1');
        assert.notStrictEqual(w.port, gamePort, 'the client is sent to a relay, not the server');
        assert.strictEqual(w.level, 'GoblinRiver');
        const gameRelay = hub.find('127.0.0.1', gamePort);
        assert.ok(gameRelay && gameRelay.listenPort === w.port);
        assert.deepStrictEqual(redirects.map((r) => r.ok), [true]);

        const c2 = net.connect(w.port, '127.0.0.1');
        await new Promise((r) => c2.on('connect', r));
        const script = Buffer.concat([pkt.fullUpdate(12, 'ksq', { isPlayer: true }), pkt.hit(301, 12, 4321, 993, false)]);
        c2.write(script);
        await new Promise((r) => setTimeout(r, 150));
        assert.ok(Buffer.concat(gameGot).equals(script), 'the game server gets what the client sent');
        assert.strictEqual(m.snapshot().totals.damage, 4321);
        c2.destroy();
        hub.close();
        game.close();
        login.close();
    });

    await check('DoT ticks on a training dummy are counted and kept from the server', async () => {
        const toServer = [];
        const upstream = net.createServer((sock) => sock.on('data', (d) => toServer.push(d)));
        await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
        const relay = new GameRelay({ listenPort: 0, upstreamHost: '127.0.0.1', upstreamPort: upstream.address().port });
        await relay.listen();
        const m = new DpsMeter({ powers: table });
        m.start();
        relay.on('connection', (tr) => tr.on('damage', (e) => m.recordDamage(e)));
        const c = net.connect(relay.listenPort, '127.0.0.1');
        await new Promise((r) => c.on('connect', r));
        const before = Buffer.concat([
            pkt.fullUpdate(12, 'ksq', { isPlayer: true }),
            pkt.fullUpdate(900, 'HomeDummy2', { team: 2 }),
            pkt.hit(900, 12, 5000, 993, false)
        ]);
        const dummyTick = pkt.dot(900, 12, 993, 700);
        const after = Buffer.concat([pkt.dot(301, 12, 993, 300), pkt.cast(12, 993)]);
        const all = Buffer.concat([before, dummyTick, after]);
        for (let i = 0; i < all.length; i += 3) {
            c.write(all.subarray(i, i + 3));
            await new Promise((r) => setTimeout(r, 1));
        }
        await new Promise((r) => setTimeout(r, 200));
        assert.ok(Buffer.concat(toServer).equals(Buffer.concat([before, after])), 'the server gets everything but the dummy tick');
        const s = m.snapshot();
        assert.strictEqual(s.totals.damage, 6000);
        assert.strictEqual(s.totals.dotDamage, 1000);
        assert.deepStrictEqual(s.byStat, { attack: 5000, expertise: 1000, unknown: 0 });
        assert.strictEqual(relay.dummyTicksKept, 1);
        c.destroy();
        relay.close();
        upstream.close();
    });

    console.log('Web proxy');
    await check('passes requests through and patches only DungeonBlitz.swf', async () => {
        const seen = [];
        const site = http.createServer((req, res) => {
            const body = [];
            req.on('data', (d) => body.push(d));
            req.on('end', () => {
                seen.push({ url: req.url, headers: req.headers, body: Buffer.concat(body).toString() });
                if (req.url.startsWith('/p/cbp/DungeonBlitz.swf')) {
                    res.writeHead(200, { 'content-type': 'application/x-shockwave-flash', 'cache-control': 'no-cache', etag: 'W/"1"' });
                    res.end('ORIGINAL-SWF');
                    return;
                }
                if (req.url === '/gone') {
                    res.writeHead(404);
                    res.end('nope');
                    return;
                }
                res.setHeader('set-cookie', ['a=1; Path=/', 'b=2; Path=/']);
                res.writeHead(200, { 'content-type': 'text/plain' });
                res.write('chunk1-');
                setTimeout(() => res.end('chunk2:' + req.method + ':' + Buffer.concat(body).toString()), 10);
            });
        });
        await new Promise((r) => site.listen(0, '127.0.0.1', r));
        const sitePort = site.address().port;
        const proxy = new WebProxy({
            listenPort: 0,
            hosts: [{ host: '127.0.0.1', port: sitePort }],
            patchSwf: async (buf) => ({ swf: Buffer.concat([Buffer.from('PATCHED-'), buf]), report: { ok: true } })
        });
        assert.ok(await proxy.listen());
        const pport = proxy.server.address().port;
        const ask = (method, url, headers, body, host) =>
            new Promise((resolve, reject) => {
                const req = http.request({ host: '127.0.0.1', port: pport, method, path: url, headers: Object.assign({ host: host || '127.0.0.1:' + sitePort }, headers) }, (res) => {
                    const parts = [];
                    res.on('data', (d) => parts.push(d));
                    res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(parts).toString() }));
                });
                req.on('error', reject);
                req.end(body);
            });
        const swf = await ask('GET', '/p/cbp/DungeonBlitz.swf?fv=cbp', { 'if-none-match': 'W/"1"', 'accept-encoding': 'gzip' });
        assert.strictEqual(swf.status, 200);
        assert.strictEqual(swf.body, 'PATCHED-ORIGINAL-SWF');
        assert.strictEqual(swf.headers['cache-control'], 'no-store');
        assert.strictEqual(swf.headers.etag, undefined);
        assert.strictEqual(Number(swf.headers['content-length']), 'PATCHED-ORIGINAL-SWF'.length);
        assert.strictEqual(seen[0].headers['if-none-match'], undefined, 'never "not modified" for the SWF');
        assert.strictEqual(proxy.swf.ok, true);
        const page = await ask('POST', '/api/thing', { cookie: 'x=1', 'content-type': 'text/plain' }, 'hello');
        assert.strictEqual(page.body, 'chunk1-chunk2:POST:hello');
        assert.deepStrictEqual(page.headers['set-cookie'], ['a=1; Path=/', 'b=2; Path=/']);
        assert.strictEqual(seen[1].headers.cookie, 'x=1');
        assert.strictEqual(seen[1].headers.host, '127.0.0.1:' + sitePort, 'the Host header goes on as it came');
        assert.strictEqual((await ask('GET', '/gone')).status, 404);
        assert.strictEqual((await ask('GET', '/', {}, undefined, 'elsewhere.example')).status, 502, 'other hosts are refused');
        proxy.close();
        site.close();
    });

    const liveSwf = process.env.DBDPS_LIVE_SWF;
    if (liveSwf && fs.existsSync(liveSwf)) {
        await check('patches the live DungeonBlitz.swf: login host and port only', () => {
            const swf = fs.readFileSync(liveSwf);
            const before = swfpatch.readLoginTarget(swf);
            assert.ok(before && before.host && before.port, 'login target found');
            const r = swfpatch.patchSwf(swf, { port: 13690 });
            assert.strictEqual(r.report.ok, true);
            assert.deepStrictEqual([r.report.hostPatches, r.report.portPatches, r.report.dummyDotPatches], [1, 1, 1]);
            assert.deepStrictEqual(swfpatch.readLoginTarget(r.swf), { host: '127.0.0.1', port: 13690 });
            assert.throws(() => swfpatch.patchSwf(swf, { port: 20000 }), /below 16384/);
        });
    }

    console.log('\n' + passed + ' passed, ' + failures.length + ' failed');
    process.exit(failures.length ? 1 : 0);
}

main();
