'use strict';

const { EventEmitter } = require('events');

/**
 * The fight being measured: a stopwatch, and every hit and cast that arrived while it ran.
 *
 * Damage is what the player's own client sent to the server (packet 0x0A for hits, 0x79 for DoT
 * ticks). The server can still add to it afterwards (the Soulthief passive, an admin damage
 * scale), so this is the number the client computed, which is also the number the floating
 * combat text shows.
 */

const MAX_HITS_LOGGED = 50000;
const MAX_ROTATION = 20000;
const ROTATION_SHOWN = 300;
/** How long after a cast its power's hits and DoT ticks still count toward that cast. */
const CAST_WINDOW_MS = 60000;
const STATS = ['attack', 'expertise', 'unknown'];
/** The game's hotbar locations (AbilityTypes HotbarLocation) and the keys that fire them. */
const SLOT_KEYS = { 1: '1', 2: '2', 3: '3', 4: '4', 5: 'E', 6: 'Q' };

/** Up to two capitals of a name, for a power that has no hotbar key: "Poison Strike" -> "PS". */
function initials(label) {
    const words = String(label || '').replace(/[^A-Za-z0-9 ]+/g, ' ').trim().split(/\s+/).filter(Boolean);
    if (!words.length) return '?';
    if (words.length === 1) return words[0].slice(0, 2);
    return (words[0][0] + words[1][0]).toUpperCase();
}

/**
 * A basic attack power: no hotbar ability, no mana cost (ManaCost "0,5": costs 0, gives 5), and
 * not a gear or rune proc. Used when the cast packet carries no combo field.
 */
function isBasicPower(p) {
    if (!p || p.monster || (p.ability && p.ability[2] > 0)) return false;
    if (/^(Legendary|Mystic|Rune)/.test(p.name)) return false;
    return /^0(,|$)/.test(String(p.mana || '').trim());
}

function emptyStats() {
    return { attack: 0, expertise: 0, unknown: 0 };
}

class DpsMeter extends EventEmitter {
    constructor({ powers, now } = {}) {
        super();
        this.powers = powers || null;
        this.now = now || (() => Date.now());
        this.autoStart = false;
        this.equipped = [];      // [{ group, key, label, rank }] from the latest spell scan
        this.scanAbilities = {}; // group -> ability entry from the scan
        this.reset();
    }

    setPowers(powers) {
        this.powers = powers;
        // Labels and scaling come from the table, so rows built before it changed are refreshed.
        for (const row of this.rows.values()) {
            const p = this.powers && this.powers.get(row.lastPowerId);
            if (p && !row.summon) {
                row.label = p.ability && p.ability[2] > 0 ? p.abilityLabel : p.label;
            }
        }
        this.emit('change');
    }

    setSpellScan(scan) {
        this.equipped = [];
        this.scanAbilities = {};
        if (scan && Array.isArray(scan.abilities)) {
            for (const a of scan.abilities) {
                if (a && a.key) {
                    this.scanAbilities[a.key] = a;
                }
            }
        }
        if (scan && Array.isArray(scan.hotbar)) {
            for (const h of scan.hotbar) {
                if (h && h.key) {
                    this.equipped.push({ group: h.key, key: String(h.slotKey || h.slot || ''), label: h.name || h.key, rank: h.rank || 0 });
                }
            }
        }
        this.emit('change');
    }

    /* ---------- the stopwatch ---------- */

    get state() {
        return this._state;
    }

    elapsedMs() {
        return this.accumMs + (this._state === 'running' ? Math.max(0, this.now() - this.segmentStart) : 0);
    }

    start() {
        if (this._state === 'running') {
            return;
        }
        if (this._state === 'idle') {
            this.startedAt = new Date(this.now()).toISOString();
        }
        this._state = 'running';
        this.segmentStart = this.now();
        this.emit('change');
    }

    stop() {
        if (this._state !== 'running') {
            return;
        }
        this.accumMs += Math.max(0, this.now() - this.segmentStart);
        this._state = 'stopped';
        this.stoppedAt = new Date(this.now()).toISOString();
        this.emit('change');
    }

    toggle() {
        if (this._state === 'running') this.stop();
        else this.start();
    }

    reset() {
        this._state = 'idle';
        this.accumMs = 0;
        this.segmentStart = 0;
        this.startedAt = '';
        this.stoppedAt = '';
        this.rows = new Map();
        this.targets = new Map();
        this.timeline = [];
        this.hitsLog = [];
        this.totals = { damage: 0, hits: 0, casts: 0, crits: 0, critDamage: 0, dotDamage: 0, dotTicks: 0, summonDamage: 0 };
        this.byStat = emptyStats();
        this.ignored = { hits: 0, damage: 0, casts: 0 };
        this.levels = [];
        this.rotation = []; // every cast, in order: see recordCast
        this.rotationSeq = 0;
        this.lastCast = new Map(); // powerId -> its latest rotation entry
        this.lastByKey = new Map(); // spell row key -> its latest rotation entry
        this.emit('change');
    }

    /* ---------- input ---------- */

    rowFor(powerId, summonName) {
        const p = this.powers ? this.powers.get(powerId) : null;
        let key;
        let label;
        if (p) {
            // Hotbar abilities by their base power (every rank in one row). Everything else
            // (basic attacks, rune procs, pets) by its name, so two "Sword Melee" powers share a row.
            const hotbar = p.ability && p.ability[2] > 0;
            key = hotbar ? p.abilityKey : 'name:' + p.label;
            label = hotbar ? p.abilityLabel : p.label;
        } else if (summonName) {
            key = 'summon:' + summonName;
            label = summonName;
        } else {
            key = 'power:' + powerId;
            label = 'Power #' + powerId;
        }
        let row = this.rows.get(key);
        if (!row) {
            row = {
                key,
                label,
                ranks: new Set(),
                powerIds: new Set(),
                lastPowerId: powerId,
                casts: 0,
                hits: 0,
                crits: 0,
                critDamage: 0,
                hitDamage: 0,
                dotDamage: 0,
                dotTicks: 0,
                summonDamage: 0,
                damage: 0,
                maxHit: 0,
                byStat: emptyStats(),
                firstAt: 0,
                lastAt: 0,
                summon: !p && Boolean(summonName),
                monster: Boolean(p && p.monster)
            };
            this.rows.set(key, row);
        }
        row.lastPowerId = powerId;
        row.powerIds.add(powerId);
        if (p && p.rank) {
            row.ranks.add(p.rank);
        }
        return row;
    }

    /** Called for each damage event the relay attributes to the player. */
    recordDamage({ kind, powerId, damage, crit, targetName, summon }) {
        const amount = Math.round(Math.abs(Number(damage) || 0));
        if (!amount) {
            return;
        }
        if (this._state !== 'running' && this.autoStart && this._state === 'idle') {
            this.start();
        }
        if (this._state !== 'running') {
            this.ignored.hits += 1;
            this.ignored.damage += amount;
            this.emit('ignored');
            return;
        }
        const t = this.elapsedMs();
        const row = this.rowFor(powerId, summon ? summon.name : '');
        const stat = this.powers ? this.powers.statFor(powerId, kind) : 'unknown';
        const s = STATS.includes(stat) ? stat : 'unknown';

        row.damage += amount;
        row.byStat[s] += amount;
        if (!row.firstAt) row.firstAt = t || 1;
        row.lastAt = t;
        if (kind === 'dot') {
            row.dotDamage += amount;
            row.dotTicks += 1;
            this.totals.dotDamage += amount;
            this.totals.dotTicks += 1;
        } else {
            row.hits += 1;
            row.hitDamage += amount;
            if (amount > row.maxHit) row.maxHit = amount;
            this.totals.hits += 1;
            if (crit) {
                row.crits += 1;
                row.critDamage += amount;
                this.totals.crits += 1;
                this.totals.critDamage += amount;
            }
        }
        if (summon) {
            row.summonDamage += amount;
            this.totals.summonDamage += amount;
        }
        this.totals.damage += amount;
        this.byStat[s] += amount;

        const name = targetName || 'Unknown target';
        const tg = this.targets.get(name) || { name, damage: 0, hits: 0 };
        tg.damage += amount;
        tg.hits += 1;
        this.targets.set(name, tg);

        const sec = Math.floor(t / 1000);
        while (this.timeline.length <= sec) this.timeline.push(0);
        this.timeline[sec] += amount;

        if (this.hitsLog.length < MAX_HITS_LOGGED) {
            this.hitsLog.push([Math.round(t), powerId, amount, crit ? 1 : 0, kind === 'dot' ? 'dot' : 'hit', name, summon ? summon.name : '']);
        }

        // The cast this hit or tick belongs to: the latest cast of the same power. A recast
        // refreshes a DoT, so later ticks go to the newer cast.
        let entry = summon ? null : this.lastCast.get(powerId);
        if (!entry && !summon && this.powers) {
            // A follow-up or rune power that was never cast itself (a Bleed a legendary rune adds):
            // its damage goes to the latest cast of its skill.
            const p = this.powers.get(powerId);
            if (p && p.followUp) entry = this.lastByKey.get(row.key) || null;
        }
        if (entry && t - entry.t <= CAST_WINDOW_MS) {
            entry.damage += amount;
            if (kind === 'dot') {
                entry.dotDamage += amount;
                entry.dotTicks += 1;
            } else {
                entry.hits += 1;
                entry.hitDamage += amount;
                if (crit) entry.crits += 1;
            }
        }
        this.emit('change');
    }

    /**
     * What a cast was: a hotbar 'spell', a basic attack ('melee' or 'ranged'), or 'other'.
     * Melee or ranged comes from the power's TargetMethod in the game data (MeleeCombo,
     * MeleePunch / ProjectilePlayer, ProjectileCombo): Bone Daggers are thrown, so ranged, even
     * though the cast packet can carry a melee combo step. Only without that does the cast's own
     * combo field or projectile decide.
     */
    castKind(powerId, combo, projectile) {
        const p = this.powers ? this.powers.get(powerId) : null;
        if (p && p.ability && p.ability[2] > 0) return 'spell';
        if (!combo && !isBasicPower(p)) return 'other';
        const how = p ? p.targetMethod : '';
        if (/projectile|ranged|lobbed/i.test(how)) return 'ranged';
        if (/melee|cleave|punch/i.test(how)) return 'melee';
        if (combo) return combo.isMelee ? 'melee' : 'ranged';
        return /melee/i.test(p.name) || !projectile ? 'melee' : 'ranged';
    }

    /**
     * A cast by the player (packet 0x09). combo: the cast's basic-attack combo field, if any;
     * projectile: whether it fired a projectile.
     *
     * Every spell cast is its own rotation entry. Basic attacks in a row are one entry, a run,
     * until something else is cast: they are the most frequent casts by far, and the run's
     * count (MA3, RA5) goes up with each hit it lands.
     */
    recordCast({ powerId, combo, projectile }) {
        // A cast alone never starts the clock (auto-start waits for the first hit).
        if (this._state !== 'running') {
            this.ignored.casts += 1;
            return;
        }
        const row = this.rowFor(powerId, '');
        const p = this.powers ? this.powers.get(powerId) : null;
        const kind = this.castKind(powerId, combo, projectile);
        const t = Math.round(this.elapsedMs());
        // A skill's follow-up (Mist Walk's closing strike, Charon's Blades' avatar attacks) is
        // part of the cast that started it, not another press of the key.
        if (p && p.followUp) {
            const parent = this.lastByKey.get(row.key);
            if (parent && t - parent.endT <= CAST_WINDOW_MS) {
                parent.endT = t;
                parent.powerIds.add(powerId);
                this.lastCast.set(powerId, parent);
                this.emit('change');
                return;
            }
        }
        row.casts += 1;
        this.totals.casts += 1;
        const last = this.rotation[this.rotation.length - 1];
        if ((kind === 'melee' || kind === 'ranged') && last && last.kind === kind) {
            last.casts += 1;
            last.endT = t;
            last.powerIds.add(powerId);
            this.lastCast.set(powerId, last);
            this.emit('change');
            return;
        }
        const entry = {
            id: ++this.rotationSeq,
            t,
            endT: t,
            powerId,
            powerIds: new Set([powerId]),
            kind,
            key: row.key,
            group: p ? p.abilityKey || p.group || '' : '',
            slot: kind === 'spell' && p && p.ability ? p.ability[2] : 0,
            label: row.label,
            rank: p && p.rank ? p.rank : 0,
            casts: 1,
            hits: 0,
            crits: 0,
            hitDamage: 0,
            dotDamage: 0,
            dotTicks: 0,
            damage: 0
        };
        this.rotation.push(entry);
        if (this.rotation.length > MAX_ROTATION) this.rotation.shift();
        this.lastCast.set(powerId, entry);
        this.lastByKey.set(row.key, entry);
        this.emit('change');
    }

    /**
     * What a rotation entry shows: s and a spell's hotbar slot from the game's data (s1-s6 for
     * keys 1, 2, 3, 4, E, Q), MA or RA plus the hits so far for a run of basic attacks, initials
     * for anything else.
     */
    badge(entry) {
        if (entry.kind === 'melee') return 'MA' + entry.hits;
        if (entry.kind === 'ranged') return 'RA' + entry.hits;
        if (entry.slot > 0) return 's' + entry.slot;
        return initials(entry.label);
    }

    /**
     * Rotation entries worth showing: every spell cast; a run of basic attacks once it has hit
     * something; anything else once it deals damage.
     */
    rotationEntries() {
        return this.rotation.filter((e) => (e.kind === 'spell' ? true : e.kind === 'other' ? e.damage > 0 : e.hits > 0 || e.damage > 0));
    }

    rotationView(limit) {
        const list = this.rotationEntries();
        const shown = limit ? list.slice(-limit) : list;
        return {
            count: list.length,
            casts: list.reduce((n, e) => n + e.casts, 0),
            text: list.filter((e) => e.kind !== 'other').map((e) => this.badge(e)).join(' '),
            entries: shown.map((e) => ({
                id: e.id,
                t: e.t,
                endT: e.endT,
                badge: this.badge(e),
                kind: e.kind,
                key: e.key,
                group: e.group,
                label: e.label,
                rank: e.rank,
                slot: e.slot,
                slotKey: SLOT_KEYS[e.slot] || '',
                powerId: e.powerId,
                powerIds: Array.from(e.powerIds),
                casts: e.casts,
                damage: e.damage,
                hitDamage: e.hitDamage,
                dotDamage: e.dotDamage,
                dotTicks: e.dotTicks,
                hits: e.hits,
                crits: e.crits
            }))
        };
    }

    noteLevel(level) {
        if (level && this.levels[this.levels.length - 1] !== level) {
            this.levels.push(level);
        }
    }

    /* ---------- output ---------- */

    rowView(row, total, seconds) {
        const scan = this.scanAbilities[row.key] || null;
        const p = this.powers ? this.powers.get(row.lastPowerId) : null;
        const ranks = Array.from(row.ranks).sort((a, b) => a - b);
        return {
            key: row.key,
            label: row.label,
            rank: ranks.length ? ranks[ranks.length - 1] : scan ? scan.rank || 0 : 0,
            ranks,
            casts: row.casts,
            hits: row.hits,
            crits: row.crits,
            critRate: row.hits ? row.crits / row.hits : 0,
            damage: row.damage,
            share: total ? row.damage / total : 0,
            dps: seconds > 0 ? row.damage / seconds : 0,
            hitDamage: row.hitDamage,
            dotDamage: row.dotDamage,
            dotTicks: row.dotTicks,
            summonDamage: row.summonDamage,
            avgHit: row.hits ? row.hitDamage / row.hits : 0,
            maxHit: row.maxHit,
            byStat: Object.assign({}, row.byStat),
            scaling: scan && scan.scalingText ? scan.scalingText : p && p.scaling.text ? p.scaling.text : '',
            description: scan && scan.description ? scan.description : p ? p.description : '',
            damageType: p ? p.damageType : '',
            powerIds: Array.from(row.powerIds),
            powerKey: p ? p.abilityKey || p.group || String(p.name || '').replace(/\d+$/, '') : '',
            slot: p && p.ability && p.ability[2] > 0 ? p.ability[2] : 0,
            summon: row.summon,
            monster: row.monster,
            hotkey: '',
            equipped: false
        };
    }

    snapshot() {
        const ms = this.elapsedMs();
        // At least one second, so the first hit after Start doesn't read as millions per second.
        const seconds = ms > 0 ? Math.max(ms / 1000, 1) : 0;
        const total = this.totals.damage;
        const views = new Map();
        for (const row of this.rows.values()) {
            views.set(row.key, this.rowView(row, total, seconds));
        }
        // Equipped spells come first, in hotbar order, even before they've done anything.
        const equippedRows = [];
        for (const e of this.equipped) {
            let v = views.get(e.group);
            if (!v) {
                v = this.rowView(
                    {
                        key: e.group, label: e.label, ranks: new Set(e.rank ? [e.rank] : []), powerIds: new Set(), lastPowerId: 0,
                        casts: 0, hits: 0, crits: 0, critDamage: 0, hitDamage: 0, dotDamage: 0, dotTicks: 0, summonDamage: 0,
                        damage: 0, maxHit: 0, byStat: emptyStats(), summon: false, monster: false
                    },
                    total,
                    seconds
                );
            }
            v.equipped = true;
            v.hotkey = e.key;
            const ab = this.powers && this.powers.abilities ? this.powers.abilities[e.group] : null;
            if (!v.slot && ab) v.slot = ab[2] || 0;
            views.delete(e.group);
            equippedRows.push(v);
        }
        // Without a spell scan, the hotbar spells you've used stand in for it, in slot order.
        if (!this.equipped.length) {
            for (const v of Array.from(views.values()).filter((r) => r.slot > 0).sort((a, b) => a.slot - b.slot || b.damage - a.damage)) {
                v.hotkey = SLOT_KEYS[v.slot] || '';
                views.delete(v.key);
                equippedRows.push(v);
            }
        }
        const others = Array.from(views.values()).sort((a, b) => b.damage - a.damage || b.casts - a.casts);
        const last = this.timeline.length;
        return {
            state: this._state,
            autoStart: this.autoStart,
            startedAt: this.startedAt,
            elapsedMs: ms,
            totals: Object.assign({}, this.totals),
            dps: seconds > 0 ? total / seconds : 0,
            critRate: this.totals.hits ? this.totals.crits / this.totals.hits : 0,
            byStat: Object.assign({}, this.byStat),
            ignored: Object.assign({}, this.ignored),
            equipped: equippedRows,
            others,
            timeline: this.timeline.slice(Math.max(0, last - 60)),
            timelineStart: Math.max(0, last - 60),
            levels: this.levels.slice(),
            rotation: this.rotationView(ROTATION_SHOWN),
            dpsSeries: this.dpsSeries()
        };
    }

    /**
     * DPS over the whole fight for the graph, in at most `points` buckets: the DPS over the last
     * 5 seconds at each moment (single big hits would otherwise flatten everything else), and the
     * running average (total so far / time so far) at the end of each bucket. `peak` is the best
     * 5 seconds. The second still in progress is left out while the clock runs.
     */
    dpsSeries(points) {
        const max = points || 90;
        let n = this.timeline.length;
        if (this._state === 'running' && n > 1) n -= 1;
        if (n < 2) return { bucketSec: 1, seconds: n, perSecond: [], running: [], peak: 0 };
        const rolling = [];
        let win = 0;
        for (let i = 0; i < n; i++) {
            win += this.timeline[i];
            if (i >= 5) win -= this.timeline[i - 5];
            rolling.push(win / Math.min(5, i + 1));
        }
        const size = Math.ceil(n / max);
        const perSecond = [];
        const running = [];
        let total = 0;
        for (let start = 0; start < n; start += size) {
            const end = Math.min(n, start + size);
            let sum = 0;
            let roll = 0;
            for (let i = start; i < end; i++) {
                sum += this.timeline[i];
                roll += rolling[i];
            }
            total += sum;
            perSecond.push(Math.round(roll / (end - start)));
            running.push(Math.round(total / end));
        }
        return { bucketSec: size, seconds: n, perSecond, running, peak: Math.round(Math.max.apply(null, rolling)) };
    }

    /** Everything, for the export file. */
    report() {
        const snap = this.snapshot();
        const rows = snap.equipped.concat(snap.others);
        return {
            snapshot: snap,
            rows,
            targets: Array.from(this.targets.values()).sort((a, b) => b.damage - a.damage),
            timeline: this.timeline.slice(),
            hits: this.hitsLog.slice(),
            rotation: this.rotationView(0).entries,
            stoppedAt: this.stoppedAt
        };
    }
}

module.exports = { DpsMeter, initials, isBasicPower, SLOT_KEYS };
