'use strict';

/**
 * Export formats for one measured fight: a JSON file with everything (format "dbb-dps"),
 * a CSV table of spells for spreadsheets, and a short text summary for chat.
 */

function round(n, d) {
    const f = Math.pow(10, d || 0);
    return Math.round((Number(n) || 0) * f) / f;
}

function clock(ms) {
    const total = Math.max(0, Math.floor(ms / 100));
    const tenths = total % 10;
    const s = Math.floor(total / 10);
    const m = Math.floor(s / 60);
    const h = Math.floor(m / 60);
    const pad = (x) => String(x).padStart(2, '0');
    return (h ? h + ':' + pad(m % 60) : String(m)) + ':' + pad(s % 60) + '.' + tenths;
}

function int(n) {
    return Math.round(Number(n) || 0).toLocaleString('en-US');
}

/**
 * The key a spell goes by in the export, in the game's own vocabulary (the DPS Calculator's too):
 * the ability for hotbar spells ("PoisonStrike"), the power's base name for everything else
 * ("RapierMelee"), the summon's name for pets.
 */
function spellKey(r) {
    if (r.equipped || (r.key && !/^(name|summon|power):/.test(r.key))) return r.key;
    if (r.powerKey) return r.powerKey;
    if (/^summon:/.test(r.key)) return r.key.slice(7).replace(/[^A-Za-z0-9]+/g, '');
    return r.key.replace(/^(name|power):/, '').replace(/[^A-Za-z0-9]+/g, '');
}

function spellRow(r) {
    return {
        key: spellKey(r),
        name: r.label,
        rank: r.rank || null,
        ranksSeen: r.ranks,
        slotKey: r.hotkey || null,
        equipped: r.equipped,
        summon: r.summon || false,
        casts: r.casts,
        hits: r.hits,
        crits: r.crits,
        critRate: round(r.critRate, 4),
        damage: r.damage,
        share: round(r.share, 4),
        dps: round(r.dps, 1),
        directDamage: r.hitDamage,
        dotDamage: r.dotDamage,
        dotTicks: r.dotTicks,
        summonDamage: r.summonDamage,
        averageHit: round(r.avgHit, 1),
        biggestHit: r.maxHit,
        damageByStat: r.byStat,
        scaling: r.scaling || null,
        damageType: r.damageType || null,
        description: r.description || null,
        powerIds: r.powerIds
    };
}

/** The Dungeon mode run, as the export describes it; null without Dungeon mode. */
function dungeonOf(s) {
    const d = s.dungeon;
    if (!d) return null;
    return {
        level: d.runLevel || d.level || '',
        name: d.runLevelName || d.levelName || '',
        completion: d.completion === null || d.completion === undefined ? null : d.completion,
        state: d.phase,
        endedBy: d.endedBy || null, // boss, cleared, complete, left, manual
        deaths: d.deaths,
        idlePauses: d.idlePauses,
        bosses: (d.bosses || []).map((b) => ({ name: b.name, atMs: b.atMs, at: clock(b.atMs) }))
    };
}

const ENDED_BY = { boss: 'boss defeated', cleared: '100% cleared', complete: 'dungeon complete', left: 'left the dungeon', manual: 'stopped' };

/** A rotation step in the DPS Calculator's combo vocabulary: an ability key, or "basic". */
function stepKey(e) {
    if (e.kind === 'melee' || e.kind === 'ranged') return 'basic';
    return e.group || e.label.replace(/[^A-Za-z0-9]+/g, '');
}

function rotationCast(e, i) {
    const basic = e.kind === 'melee' || e.kind === 'ranged';
    return {
        index: i + 1,
        atMs: e.t,
        at: clock(e.t),
        endMs: e.endT === undefined ? e.t : e.endT,
        key: basic ? 'basic' : stepKey(e),
        name: e.label,
        kind: e.kind,
        label: e.badge,
        slot: e.slot || null,
        slotKey: e.slotKey || null,
        casts: e.casts || 1,
        rank: e.rank || null,
        powerId: e.powerId,
        damage: e.damage,
        directDamage: e.hitDamage,
        dotDamage: e.dotDamage,
        dotTicks: e.dotTicks,
        hits: e.hits,
        crits: e.crits
    };
}

/** The rotation as DPS Calculator combo steps: one entry per cast, a run of basic attacks expanded. */
function rotationSteps(rotation) {
    const out = [];
    for (const e of rotation) {
        const n = e.kind === 'melee' || e.kind === 'ranged' ? e.casts || 1 : 1;
        for (let k = 0; k < n; k++) out.push(stepKey(e));
    }
    return out;
}

/**
 * The fight as one JSON document, laid out the way GOOD (Genshin Open Object Description, the
 * format Genshin Optimizer imports) lays out an inventory: a format/version/source header, then
 * flat lists of objects that name things by the game's own keys, with slotKey for where a spell
 * sits on the hotbar. format "dbb-dps", version 2.
 */
function toJson(report, meta) {
    const s = report.snapshot;
    const total = s.totals.damage;
    const rotation = report.rotation || [];
    const share = (n) => (total ? round(n / total, 4) : 0);
    const spellOf = new Map(report.rows.map((r) => [r.key, spellKey(r)]));
    return {
        format: 'dbb-dps',
        version: 2,
        source: meta.source,
        exportedAt: new Date().toISOString(),
        character: {
            key: (meta.character || '').replace(/\s+/g, ''),
            name: meta.character || '',
            class: meta.className || '',
            spellScan: meta.scan || null
        },
        fight: {
            state: s.state,
            startedAt: s.startedAt || null,
            stoppedAt: report.stoppedAt || null,
            durationMs: Math.round(s.elapsedMs),
            duration: clock(s.elapsedMs),
            levels: s.levels,
            damage: total,
            dps: round(s.dps, 1),
            casts: s.totals.casts,
            hits: s.totals.hits,
            crits: s.totals.crits,
            critRate: round(s.critRate, 4),
            critDamage: s.totals.critDamage,
            dotDamage: s.totals.dotDamage,
            dotTicks: s.totals.dotTicks,
            summonDamage: s.totals.summonDamage,
            outsideTimer: s.ignored,
            dungeon: dungeonOf(s)
        },
        distribution: {
            byStat: {
                attack: { damage: s.byStat.attack, share: share(s.byStat.attack) },
                expertise: { damage: s.byStat.expertise, share: share(s.byStat.expertise) },
                unknown: { damage: s.byStat.unknown, share: share(s.byStat.unknown) }
            },
            byKind: {
                direct: { damage: total - s.totals.dotDamage, share: share(total - s.totals.dotDamage) },
                dot: { damage: s.totals.dotDamage, share: share(s.totals.dotDamage) }
            },
            crits: { damage: s.totals.critDamage, share: share(s.totals.critDamage), rate: round(s.critRate, 4) }
        },
        spells: report.rows.map(spellRow),
        rotation: {
            text: rotation.filter((e) => e.kind !== 'other').map((e) => e.badge).join(' '),
            steps: rotationSteps(rotation),
            casts: rotation.map(rotationCast)
        },
        targets: report.targets.map((t) => ({ name: t.name, damage: t.damage, hits: t.hits, share: share(t.damage) })),
        damagePerSecond: report.timeline,
        hits: report.hits.map((h) => ({ atMs: h[0], powerId: h[1], damage: h[2], crit: Boolean(h[3]), kind: h[4], target: h[5], summon: h[6] || null, spell: spellOf.get(h[7]) || null })),
        notes: [
            'Damage is what your game client sent to the server for each hit (packet 0x0A) and DoT tick (packet 0x79), including DoT ticks on the house training dummies, which the meter reads but never forwards. The server can add to it afterwards (the Soulthief passive, admin damage scaling), which is not included.',
            'rotation.casts lists the casts (packet 0x09) in order while the timer ran: each hotbar spell cast (slot 1-6 = keys 1, 2, 3, 4, E, Q), runs of basic attacks in a row as one entry (kind melee or ranged, label MA<hits> (melee attack) or RA<hits> (ranged attack), casts = how many; a spell is labelled s<slot>, s1-s6 for keys 1, 2, 3, 4, E, Q), and any other power that dealt damage. Each entry is credited with the hits and DoT ticks of its power until that power is cast again. rotation.text is the same order as shown in the Rotation window ("MA2 s2 s3 RA1 s4 s1"). rotation.steps is the same order as DPS Calculator combo steps, one "basic" per basic attack.',
            'Scaling, as the game client computes damage: every direct hit is BaseDamageMult x Attack, whatever its element (Bitter Blade, Frozen Ward and Frigid Comet included); every DoT tick carries your Expertise from when it landed (Chilblains from Frigid Comet included).',
            'fight.dungeon is there when Dungeon mode was on: the first hit started the clock; dying, or 3 seconds without damage, paused it at the last hit (durationMs counts fighting time only); endedBy says how the run ended: boss (the Level Complete right after a boss died), cleared (100% completion), complete (Level Complete), left, manual.',
            'Spells: a summon\'s damage counts for the skill that summoned it (Shadow Legion\'s clones); Charon\'s Blades\' ProcCriticalHit counts for Charon\'s Blades, except a hotbar spell\'s hit in its form, which stays with that spell (Crimson Butterfly); a skill\'s other powers count for it (Hailstone Embrace\'s Frost Armor, Black Miasma\'s Shadow Tendril). hits[].spell names the spell each hit counted for. The mount and the procs the client fires by itself are not casts.'
        ]
    };
}

function csvCell(v) {
    const s = v === null || v === undefined ? '' : String(v);
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

function toCsv(report, meta) {
    const s = report.snapshot;
    const lines = [];
    const row = (cells) => lines.push(cells.map(csvCell).join(','));
    row(['Spell', 'Rank', 'Hotbar key', 'Casts', 'Hits', 'Crits', 'Crit %', 'Damage', '% of total', 'DPS', 'Direct damage', 'DoT damage', 'Average hit', 'Biggest hit', 'Attack-scaled damage', 'Expertise-scaled damage', 'Scales with']);
    for (const r of report.rows) {
        row([
            r.label, r.rank || '', r.hotkey || '', r.casts, r.hits, r.crits, round(r.critRate * 100, 1), r.damage,
            round(r.share * 100, 1), round(r.dps, 1), r.hitDamage, r.dotDamage, round(r.avgHit, 0), r.maxHit,
            r.byStat.attack, r.byStat.expertise, r.scaling || ''
        ]);
    }
    lines.push('');
    row(['Character', meta.character || '']);
    row(['Time', clock(s.elapsedMs)]);
    row(['Total damage', s.totals.damage]);
    row(['DPS', round(s.dps, 1)]);
    row(['Casts', s.totals.casts]);
    row(['Hits', s.totals.hits]);
    row(['Crit rate %', round(s.critRate * 100, 1)]);
    row(['DoT damage', s.totals.dotDamage]);
    row(['Attack-scaled damage', s.byStat.attack]);
    row(['Expertise-scaled damage', s.byStat.expertise]);
    row(['Unclassified damage', s.byStat.unknown]);
    const dungeon = dungeonOf(s);
    if (dungeon) {
        row(['Dungeon', dungeon.name || dungeon.level]);
        row(['Completion %', dungeon.completion === null ? '' : dungeon.completion]);
        row(['Run ended', dungeon.endedBy ? ENDED_BY[dungeon.endedBy] || dungeon.endedBy : 'not yet']);
        row(['Deaths', dungeon.deaths]);
    }
    row(['Exported', new Date().toISOString()]);
    const rotation = report.rotation || [];
    if (rotation.length) {
        lines.push('');
        row(['Rotation', 'Time (s)', 'Shown as', 'Spell', 'Kind', 'Casts', 'Damage', 'Direct damage', 'DoT damage', 'Hits', 'Crits']);
        rotation.forEach((e, i) => {
            row([i + 1, round(e.t / 1000, 2), e.badge, e.label, e.kind, e.casts || 1, e.damage, e.hitDamage, e.dotDamage, e.hits, e.crits]);
        });
    }
    return lines.join('\r\n') + '\r\n';
}

function toSummary(report, meta) {
    const s = report.snapshot;
    const total = s.totals.damage || 0;
    const pct = (n) => (total ? Math.round((n / total) * 100) : 0) + '%';
    const who = meta.character ? meta.character + (meta.className ? ' (' + meta.className + ')' : '') : 'Dungeon Blitz';
    const out = [];
    out.push(who + ', ' + clock(s.elapsedMs));
    out.push(int(s.dps) + ' DPS, ' + int(total) + ' damage, ' + s.totals.casts + ' casts, ' + s.totals.hits + ' hits (' + Math.round(s.critRate * 100) + '% crit)');
    out.push('Attack ' + pct(s.byStat.attack) + ', Expertise ' + pct(s.byStat.expertise) + ', DoT ' + pct(s.totals.dotDamage));
    const dungeon = dungeonOf(s);
    if (dungeon) {
        const bits = [dungeon.name || dungeon.level || 'Dungeon run'];
        if (dungeon.completion !== null) bits.push(dungeon.completion + '% cleared');
        if (dungeon.endedBy && !(dungeon.endedBy === 'cleared' && dungeon.completion !== null)) bits.push(ENDED_BY[dungeon.endedBy] || dungeon.endedBy);
        if (dungeon.deaths) bits.push(dungeon.deaths + (dungeon.deaths === 1 ? ' death' : ' deaths'));
        out.push('Dungeon: ' + bits.join(', '));
    }
    let i = 0;
    for (const r of report.rows) {
        if (!r.damage && !r.casts) continue;
        i += 1;
        out.push(
            i + '. ' + r.label + (r.rank ? ' r' + r.rank : '') + ': ' + int(r.damage) + ' (' + Math.round(r.share * 100) + '%), ' + r.casts + ' cast' + (r.casts === 1 ? '' : 's')
        );
        if (i >= 10) break;
    }
    const rotation = report.rotation || [];
    if (rotation.length) {
        const keys = rotation.filter((e) => e.kind !== 'other').map((e) => e.badge || stepKey(e));
        out.push('Rotation: ' + keys.slice(0, 80).join(' ') + (keys.length > 80 ? ' … (' + keys.length + ' in all)' : ''));
    }
    return out.join('\n');
}

module.exports = { toJson, toCsv, toSummary, clock, stepKey };
