'use strict';

const { EventEmitter } = require('events');
const { prettify } = require('./powers');

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
/** Charon's Blades (SeekingBlades): while it is up, every hit arrives as a ProcCriticalHit. */
const CHARON = 'SeekingBlades';
/** Procs that are the hit itself, made smaller: they count for the power that hit. */
const ORIGIN_PROCS = new Set(['ProcGlancingBlow']);
/** Dungeon mode: no damage from you for this long pauses the clock (at your last hit). */
const DUNGEON_IDLE_MS = 3000;
/**
 * Casts made while the clock is stopped, in this long before the hit that starts or restarts it,
 * are part of the fight (see takeLeadIn).
 */
const LEAD_IN_MS = 3000;
/** How far back the cast whose hit (re)starts the clock is looked for, when it took longer to land. */
const CAUSE_MS = 10000;
const MAX_HELD = 40;
/** How long after a hit a proc it set off can still be put down to it (they arrive together). */
const TRIGGER_MS = 2000;
/** The key a proc's damage goes under when the hit that set it off wasn't seen. */
const UNSEEN = '';
/** A dungeon completing this soon after a boss died was that boss's doing. */
const BOSS_RECENT_MS = 15000;

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

/** Who a hit or tick landed on: the client's entity id, else its name. */
function targetKeyOf(e) {
    return e.targetId ? 'id:' + e.targetId : 'name:' + (e.targetName || '');
}

/** How many ticks a bleed proc's DoT has: one a second, for as long as its Stats line says (Hemorrhage: 3 s). */
function dotTicks(p) {
    const d = p && p.scaling ? p.scaling.dot : null;
    return d && d.seconds > 0 ? Math.round(d.seconds) : 3;
}

function median(list) {
    if (!list.length) return 0;
    const s = list.slice().sort((a, b) => a - b);
    const m = s.length >> 1;
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

class DpsMeter extends EventEmitter {
    constructor({ powers, now } = {}) {
        super();
        this.powers = powers || null;
        this.now = now || (() => Date.now());
        this.autoStart = false;
        this.equipped = [];      // [{ group, key, label, rank }] from the latest spell scan
        this.scanAbilities = {}; // group -> ability entry from the scan
        this.dungeonMode = false;
        this.playerDead = false;
        this.place = { level: '', completion: null, complete: false }; // the level you're in
        this.reset();
    }

    setPowers(powers) {
        this.powers = powers;
        // Labels and scaling come from the table, so rows built before it changed are refreshed.
        for (const row of this.rows.values()) {
            if (row.summon || !this.powers) continue;
            if (row.ability) {
                row.label = this.powers.abilityLabel(row.ability);
                continue;
            }
            const p = this.powers.get(row.lastPowerId);
            if (p) row.label = p.label;
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

    /** Starts the clock (the Start button, F6). In Dungeon mode it also carries on a run. */
    start() {
        // You chose when it starts: casts made before that aren't part of it.
        this.held = [];
        this.begin();
        if (this.dungeonMode) {
            this.setPhase('running', '');
            this.dungeon.fresh = false; // carrying this run on, not starting the next
        }
        this.emit('change');
    }

    /** The clock runs from now. False when it already was running. */
    begin() {
        if (this._state === 'running') {
            return false;
        }
        if (this._state === 'idle') {
            this.startedAt = new Date(this.now()).toISOString();
            this.dungeon.level = this.place.level;
        }
        this._state = 'running';
        this.segmentStart = this.now();
        this.dungeon.lastHitAt = this.segmentStart;
        return true;
    }

    /** Stops the clock (the Stop button, F6). In Dungeon mode that ends the run; Start carries it on. */
    stop() {
        if (this._state !== 'running') {
            return;
        }
        this.pauseClock(this.now());
        if (this.dungeonMode) {
            this.dungeon.endedBy = 'manual';
            this.setPhase('ended', 'manual');
        }
        this.emit('change');
    }

    /** Stops the clock as of `at` (a wall-clock time between the segment's start and now). */
    pauseClock(at) {
        if (this._state !== 'running') {
            return;
        }
        const end = Math.max(this.segmentStart, Math.min(this.now(), at));
        this.accumMs += end - this.segmentStart;
        this._state = 'stopped';
        this.stoppedAt = new Date(end).toISOString();
        this.clampRotation(Math.round(this.accumMs));
        // Basic attacks after the clock starts again are a new run, not more of this one.
        const last = this.rotation[this.rotation.length - 1];
        if (last) last.closed = true;
    }

    /**
     * The clock just stopped as of an earlier moment (your last hit, when a lull, a death or a
     * boss stopped it): casts made since, while the lull was being noticed, were timed past it.
     * They stay in the rotation, at the moment the clock stopped, so its times only go forward.
     */
    clampRotation(limit) {
        for (let i = this.rotation.length - 1; i >= 0; i--) {
            const e = this.rotation[i];
            if (e.endT <= limit) continue;
            e.t = Math.min(e.t, limit);
            e.endT = limit;
            for (let k = 0; k < e.times.length; k++) {
                if (e.times[k] > limit) e.times[k] = limit;
            }
        }
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
        this.held = []; // casts made while the clock was stopped, for a moment: see takeLeadIn
        this.lastHits = new Map(); // target -> Map(powerId -> your latest hit with it): what set a proc off
        this.pools = new Map(); // target and proc -> the Hemorrhage bleed on it: see recordProc
        this.runId = (this.runId || 0) + 1;
        this.lastCast = new Map(); // powerId -> its latest rotation entry
        this.lastByKey = new Map(); // spell row key -> its latest cast
        this.lastOverride = new Map(); // skill -> its latest run of enchanted basic attacks
        this.dungeon = {
            phase: this.dungeonMode ? 'waiting' : 'off', // waiting, running, paused, ended
            reason: '', // why paused or ended: idle, dead, revived, boss / boss, cleared, complete, left, manual
            level: '', // the level the run is in
            lastHitAt: 0, // wall clock of your latest damage
            endedBy: '',
            deaths: 0,
            idlePauses: 0,
            bosses: [], // [{ name, atMs }] bosses that died during the run
            lastBoss: '',
            lastBossAt: 0,
            fresh: false // a new dungeon was entered after this run: the next hit starts a new run
        };
        this.emit('change');
    }

    /* ---------- Dungeon mode ---------- */

    /**
     * Dungeon mode: the first hit starts the clock; dying, or no damage from you (hits, DoT ticks,
     * summons) for 3 seconds, pauses it at your last hit, and your next hit carries on. The run
     * ends when the dungeon is beaten: the game's Level Complete (the final boss of a boss
     * dungeon) or 100% completion. Any other boss dying pauses the clock like a lull. Entering
     * another dungeon after that: the first hit there starts a new run.
     */
    setDungeonMode(on) {
        this.dungeonMode = Boolean(on);
        const d = this.dungeon;
        if (!this.dungeonMode) {
            d.phase = 'off';
            d.reason = '';
        } else if (this._state === 'idle') {
            this.setPhase('waiting', '');
        } else if (this._state === 'running') {
            d.lastHitAt = this.now();
            this.setPhase('running', '');
        } else if (d.phase === 'off') {
            this.setPhase('paused', '');
        }
        this.emit('change');
    }

    setPhase(phase, reason) {
        this.dungeon.phase = phase;
        this.dungeon.reason = reason || '';
    }

    /** Called a few times a second: the 3-second rule. */
    tick() {
        if (!this.dungeonMode || this._state !== 'running') return;
        const d = this.dungeon;
        if (this.now() - d.lastHitAt >= DUNGEON_IDLE_MS) {
            this.pauseClock(d.lastHitAt);
            d.idlePauses += 1;
            this.setPhase('paused', 'idle');
            this.emit('change');
        }
    }

    /** Your character died (its entity state went to dead). */
    playerDied() {
        if (this.playerDead) return;
        this.playerDead = true;
        this.held = []; // what you cast before dying didn't lead to your next hit
        const d = this.dungeon;
        if (this._state !== 'idle' && d.phase !== 'ended') d.deaths += 1;
        if (this.dungeonMode && this._state === 'running') {
            this.pauseClock(d.lastHitAt);
            this.setPhase('paused', 'dead');
        }
        this.emit('change');
    }

    /** Your character is back (revived, respawned, or seen casting or hitting). */
    playerRevived() {
        if (!this.playerDead) return;
        this.playerDead = false;
        const d = this.dungeon;
        if (this.dungeonMode && d.phase === 'paused' && d.reason === 'dead') this.setPhase('paused', 'revived');
        this.emit('change');
    }

    /** A Boss-rank monster died (name as the game shows it). */
    bossDied(name) {
        const d = this.dungeon;
        d.lastBoss = name || 'A boss';
        d.lastBossAt = this.now();
        if (this._state === 'idle' || d.phase === 'ended') return;
        if (this.dungeonMode && this._state === 'running') {
            // The killing blow was your last hit, or near enough.
            this.pauseClock(d.lastHitAt);
            this.setPhase('paused', 'boss');
        }
        d.bosses.push({ name: d.lastBoss, atMs: Math.round(this.elapsedMs()) });
        this.emit('change');
    }

    /** The dungeon's completion percent (packet 0xb7). 100 ends a run. */
    levelProgress(percent) {
        const p = Math.max(0, Math.min(100, Number(percent) || 0));
        this.place.completion = p;
        if (p >= 100) this.endRun('cleared');
        this.emit('change');
    }

    /** The game's Level Complete (0x3f from the client, 0x87 from the server). */
    levelComplete() {
        this.place.complete = true;
        this.endRun(this.now() - this.dungeon.lastBossAt < BOSS_RECENT_MS ? 'boss' : 'complete');
        this.emit('change');
    }

    endRun(by) {
        const d = this.dungeon;
        if (!this.dungeonMode || this._state === 'idle' || d.phase === 'ended') return;
        if (this._state === 'running') this.pauseClock(d.lastHitAt);
        d.endedBy = by;
        this.setPhase('ended', by);
    }

    /**
     * Entering a level (0x21). Leaving the run's level ends the run; entering a dungeon after a
     * run (ended, or elsewhere) makes the next hit start a new one.
     */
    noteLevel(level) {
        if (!level) return;
        if (this.place.level !== level) {
            this.place = { level, completion: null, complete: false };
            this.playerDead = false;
            this.held = []; // casts in the last level aren't part of a fight in this one
            this.lastHits = new Map(); // entity ids are the level's own
            this.pools = new Map();
            const d = this.dungeon;
            if (this.dungeonMode && this._state !== 'idle') {
                if (d.level && d.level !== level) this.endRun('left');
                const info = this.powers && this.powers.levelInfo ? this.powers.levelInfo(level) : { dungeon: /Dungeon|Mission/i.test(level) };
                if (info.dungeon && d.phase === 'ended') d.fresh = true;
            }
        }
        if (this.levels[this.levels.length - 1] !== level) {
            this.levels.push(level);
        }
        this.emit('change');
    }

    /** What the Damage Meter window and the export say about the run. */
    dungeonView() {
        if (!this.dungeonMode) return null;
        const d = this.dungeon;
        const info = this.powers && this.powers.levelInfo && this.place.level ? this.powers.levelInfo(this.place.level) : { name: this.place.level, displayName: this.place.level, dungeon: false };
        const runInfo = d.level && this.powers && this.powers.levelInfo ? this.powers.levelInfo(d.level) : null;
        return {
            phase: d.phase,
            reason: d.reason,
            endedBy: d.endedBy,
            level: this.place.level,
            levelName: info.displayName || '',
            isDungeon: Boolean(info.dungeon),
            completion: this.place.completion,
            runLevel: d.level,
            runLevelName: runInfo ? runInfo.displayName : d.level,
            deaths: d.deaths,
            idlePauses: d.idlePauses,
            bosses: d.bosses.slice(-10),
            lastBoss: d.lastBoss,
            playerDead: this.playerDead,
            nextRunPending: d.fresh,
            idleSeconds: DUNGEON_IDLE_MS / 1000
        };
    }

    /* ---------- input ---------- */

    /**
     * The spell table row for a power. opts.ability puts it in that hotbar skill's row (a summon's
     * hits in Shadow Legion's, a ProcCriticalHit in Charon's Blades'); opts.summonName gives a
     * summon no skill could be found for a row of its own.
     */
    rowFor(powerId, opts) {
        const o = opts || {};
        const P = this.powers;
        const p = P ? P.get(powerId) : null;
        let ability = o.ability || '';
        if (!ability && p && p.abilityKey && p.ability && p.ability[2] > 0) ability = p.abilityKey;
        let key;
        let label;
        if (ability) {
            // Hotbar abilities by their base power (every rank in one row).
            key = ability;
            label = P ? P.abilityLabel(ability) : ability;
        } else if (o.summonName) {
            label = prettify(o.summonName) || o.summonName;
            key = 'summon:' + label;
        } else if (p) {
            // Everything else (basic attacks, rune procs) by its name, so two "Melee" powers share a row.
            key = 'name:' + p.label;
            label = p.label;
        } else {
            key = 'power:' + powerId;
            label = 'Power #' + powerId;
        }
        let row = this.rows.get(key);
        if (!row) {
            row = {
                key,
                label,
                ability,
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
                summon: !ability && Boolean(o.summonName),
                monster: Boolean(!ability && p && p.monster),
                triggers: new Map(), // a proc's damage by the spell whose hit set it off: see creditTrigger
                ratios: [] // a proc's damage over the hit that set it off, as measured
            };
            this.rows.set(key, row);
        }
        row.lastPowerId = powerId;
        row.powerIds.add(powerId);
        if (p && p.rank && (!ability || p.abilityKey === ability)) {
            row.ranks.add(p.rank);
        }
        return row;
    }

    /**
     * Where a damage event goes, by the game's own rules:
     *
     *  - a summon's hits and ticks count for the skill that summoned it: the summon's 0x08 names
     *    the summoning power (Entity.var_99), else its entity type is in a skill's
     *    SpawnedMonsters (Shadow Legion's clones and their Sword Melee and monster attacks);
     *  - a ProcCriticalHit is Charon's Blades: while it is up the client turns every hit into one,
     *    worth the hit plus Charon's bonus (CombatState.method_1192), and the hit packet names the
     *    power that hit (its first optional id, ActivePower.var_249). A hotbar spell's hit stays
     *    with that spell (Crimson Butterfly cast in Charon's form is Crimson Butterfly damage);
     *    the rest, Charon's form's attacks, are Charon's Blades;
     *  - a glancing blow is the hit itself, halved: it counts for the power that hit.
     *
     * Returns the power whose row gets it (rowPowerId, or the skill in ability), and the power
     * whose latest cast in the rotation gets it (entryPowerId).
     */
    resolve(e) {
        const P = this.powers;
        const out = { rowPowerId: e.powerId, ability: '', summonName: '', entryPowerId: e.powerId };
        if (!P) {
            if (e.summon) out.summonName = e.summon.name || 'Summon';
            return out;
        }
        if (e.summon) {
            const key = P.summonAbility(e.summon);
            if (key) return Object.assign(out, { ability: key, entryPowerId: e.summon.powerId || e.powerId });
            return Object.assign(out, { summonName: e.summon.name || 'Summon' });
        }
        const p = P.get(e.powerId);
        const origin = e.originId && e.originId !== e.powerId ? P.get(e.originId) : null;
        if (p && p.name === 'ProcCriticalHit') {
            const own = origin && origin.abilityKey && origin.abilityKey !== CHARON && !origin.basicOverride && P.slotOf(origin.abilityKey) > 0;
            return Object.assign(out, { ability: own ? origin.abilityKey : CHARON, entryPowerId: origin ? origin.id : e.powerId });
        }
        if (p && origin && ORIGIN_PROCS.has(p.name) && !origin.monster) {
            return Object.assign(out, { rowPowerId: origin.id, entryPowerId: origin.id });
        }
        return out;
    }

    /** Called for each damage event the relay attributes to the player. */
    recordDamage(e) {
        const { kind, crit, targetName, summon } = e;
        const amount = Math.round(Math.abs(Number(e.damage) || 0));
        if (!amount) {
            return;
        }
        // A hit from your own body means you're alive, whatever we missed.
        if (kind === 'hit' && !summon && this.playerDead) this.playerRevived();
        let started = false;
        if (this.dungeonMode) {
            if (this.dungeon.fresh) {
                // The first hit in the next dungeon: a new run, with the casts that led to it.
                const autoStart = this.autoStart;
                const held = this.held;
                this.reset();
                this.autoStart = autoStart;
                this.held = held;
            }
            const d = this.dungeon;
            if (this._state !== 'running' && d.phase !== 'ended' && !this.playerDead) {
                started = this.begin();
                this.setPhase('running', '');
            }
        } else if (this._state === 'idle' && this.autoStart) {
            // Start on first hit.
            started = this.begin();
        }
        if (this._state !== 'running') {
            this.ignored.hits += 1;
            this.ignored.damage += amount;
            this.emit('ignored');
            return;
        }
        const where = this.resolve(e);
        if (started) this.takeLeadIn(where);
        const t = this.elapsedMs();
        this.dungeon.lastHitAt = this.now();
        const row = this.rowFor(where.rowPowerId, { ability: where.ability, summonName: where.summonName });
        const stat = this.powers ? this.powers.statFor(where.rowPowerId, kind) : 'unknown';
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

        // A rune proc's damage goes to the spells whose hits set it off; your own hits are kept
        // for a moment, for the procs they set off.
        const rp = this.powers ? this.powers.get(where.rowPowerId) : null;
        if (rp && rp.carriesHit) this.creditProc(e, rp, row, amount, kind);
        else if (kind === 'hit' && !summon) this.noteHit(e, row, amount);

        const name = targetName || 'Unknown target';
        const tg = this.targets.get(name) || { name, damage: 0, hits: 0 };
        tg.damage += amount;
        tg.hits += 1;
        this.targets.set(name, tg);

        const sec = Math.floor(t / 1000);
        while (this.timeline.length <= sec) this.timeline.push(0);
        this.timeline[sec] += amount;

        if (this.hitsLog.length < MAX_HITS_LOGGED) {
            this.hitsLog.push([Math.round(t), e.powerId, amount, crit ? 1 : 0, kind === 'dot' ? 'dot' : 'hit', name, summon ? summon.name : '', row.key]);
        }

        // The cast this hit or tick belongs to: the latest cast of the power that hit (for a proc,
        // the power that set it off; for a summon, the power that summoned it). A recast
        // refreshes a DoT, so later ticks go to the newer cast. Damage from a skill's power that
        // was never cast itself (Frost Armor Ice, a Bleed a legendary rune adds) goes to the
        // latest thing that skill did: its cast, or a run of the basic attacks it enchants.
        let entry = this.lastCast.get(where.entryPowerId) || null;
        if (!entry && row.ability) entry = this.latestFor(row.ability);
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

    /* ---------- procs that carry a hit (Hemorrhage, the elemental runes, Heavy Blow) ---------- */

    /** One of your hits, kept as what may set a proc off (a proc's packet names the power that hit). */
    noteHit(e, row, amount) {
        const tk = targetKeyOf(e);
        let m = this.lastHits.get(tk);
        if (!m) {
            m = new Map();
            this.lastHits.set(tk, m);
            if (this.lastHits.size > 400) this.lastHits.delete(this.lastHits.keys().next().value);
        }
        m.set(e.powerId, { key: row.key, label: row.label, damage: amount, crit: Boolean(e.crit), at: this.now() });
    }

    /** The hit that set a proc off: your latest hit on that target with the power it names, just before. */
    triggerFor(tk, originId) {
        const m = originId ? this.lastHits.get(tk) : null;
        const h = m ? m.get(originId) : null;
        return h && this.now() - h.at <= TRIGGER_MS ? h : null;
    }

    /** A proc's damage (or, with proc, one more time it went off), for the spell whose hit set it off. */
    creditTrigger(row, trig, damage, proc) {
        const key = trig ? trig.key : UNSEEN;
        let t = row.triggers.get(key);
        if (!t) {
            t = { key, label: (trig && trig.label) || 'Unknown hit', damage: 0, procs: 0, crits: 0 };
            row.triggers.set(key, t);
        }
        t.damage += damage;
        if (proc) {
            t.procs += 1;
            if (trig && trig.crit) t.crits += 1;
        }
    }

    /** Hemorrhage's bleed on a target, unless it ran out (or the target died) a while ago. */
    livePool(pk, p) {
        const pool = this.pools.get(pk);
        if (pool && this.now() - pool.at > (dotTicks(p) + 1) * 1000) {
            this.pools.delete(pk);
            return null;
        }
        return pool || null;
    }

    /**
     * A proc landed that deals no damage itself (the tracker's 'procApplied'): Hemorrhage putting
     * its bleed on a target. The bleed is sized by the hit that set it off, and a new one on a
     * bleeding target adds to what is left of the old one (the game takes off what it has paid so
     * far) and ticks over again, so each tick is shared among the hits in it, by size.
     */
    recordProc(e) {
        const p = this.powers ? this.powers.get(e.powerId) : null;
        if (!p || !p.pooled) return;
        const tk = targetKeyOf(e);
        const pk = tk + '|' + p.group;
        const trig = this.triggerFor(tk, e.originId);
        let pool = this.livePool(pk, p);
        if (!pool) {
            pool = { parts: new Map(), labels: new Map(), ticks: 0, at: 0, measure: 0 };
            this.pools.set(pk, pool);
            if (this.pools.size > 400) this.pools.delete(this.pools.keys().next().value);
        }
        const left = Math.max(0, 1 - pool.ticks / dotTicks(p));
        let before = 0;
        for (const [key, w] of pool.parts) {
            if (left > 0) {
                pool.parts.set(key, w * left);
                before += w * left;
            } else {
                pool.parts.delete(key);
            }
        }
        const key = trig ? trig.key : UNSEEN;
        pool.parts.set(key, (pool.parts.get(key) || 0) + (trig ? trig.damage : before || 1));
        pool.labels.set(key, trig ? trig.label : '');
        pool.ticks = 0;
        pool.at = this.now();
        // A fresh bleed's first tick against its hit is what the Stats line shows.
        pool.measure = !before && trig ? trig.damage : 0;
        if (this._state === 'running') {
            this.creditTrigger(this.rowFor(p.id), trig, 0, true);
            this.emit('change');
        }
    }

    /** A proc's hit or tick, for the spells whose hits set it off. */
    creditProc(e, p, row, amount, kind) {
        const tk = targetKeyOf(e);
        if (p.pooled && kind === 'dot') {
            const pk = tk + '|' + p.group;
            const pool = this.livePool(pk, p);
            if (!pool || !pool.parts.size) {
                this.creditTrigger(row, null, amount, false);
                return;
            }
            let total = 0;
            for (const w of pool.parts.values()) total += w;
            for (const [key, w] of pool.parts) {
                this.creditTrigger(row, { key, label: pool.labels.get(key) }, total ? (amount * w) / total : 0, false);
            }
            if (pool.measure) {
                row.ratios.push(amount / pool.measure);
                if (row.ratios.length > 200) row.ratios.shift();
                pool.measure = 0;
            }
            pool.ticks += 1;
            pool.at = this.now();
            if (pool.ticks >= dotTicks(p)) this.pools.delete(pk);
            return;
        }
        // An elemental rune or Heavy Blow: a hit of its own, naming the hit that set it off.
        const trig = this.triggerFor(tk, e.originId);
        this.creditTrigger(row, trig, amount, kind === 'hit');
        if (trig && kind === 'hit') {
            row.ratios.push(amount / trig.damage);
            if (row.ratios.length > 200) row.ratios.shift();
        }
    }

    /** A proc's Stats line, from what it did: "47% of the hit that set it off, every second for 3 s (141% in all)". */
    procScaling(row, p) {
        const r = median(row.ratios || []);
        const share = r ? Math.round(r * 100) + '% of the hit that set it off' : 'A share of the hit that set it off';
        if (!p.pooled) return share;
        const n = dotTicks(p);
        return share + ', every second for ' + n + ' s' + (r ? ' (' + Math.round(r * n * 100) + '% in all)' : '');
    }

    /** The latest rotation entry of a skill: its cast, or a run of the basic attacks it enchants. */
    latestFor(ability) {
        const cast = this.lastByKey.get(ability) || null;
        const run = this.lastOverride.get(ability) || null;
        if (!cast || !run) return cast || run;
        return run.endT > cast.endT ? run : cast;
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
        // A skill's own basic attacks (Hailstone Embrace's Frost Armor Melee and Ranged).
        if (p && p.basicOverride) return /projectile|lobbed/i.test(p.targetMethod) ? 'ranged' : 'melee';
        if (p && p.ability && p.ability[2] > 0) return 'spell';
        if (!combo && !isBasicPower(p)) return 'other';
        const how = p ? p.targetMethod : '';
        if (/projectile|lobbed/i.test(how)) return 'ranged';
        if (/melee|cleave|punch/i.test(how)) return 'melee';
        if (combo) return combo.isMelee ? 'melee' : 'ranged';
        if (how) return 'other';
        return /melee/i.test(p.name) || !projectile ? 'melee' : 'ranged';
    }

    /**
     * A cast by the player (packet 0x09). combo: the cast's basic-attack combo field, if any;
     * projectile: whether it fired a projectile.
     *
     * Every spell cast is its own rotation entry. Basic attacks in a row are one entry, a run,
     * until something else is cast or the clock stops: they are the most frequent casts by far,
     * and the run's count (MA3, RA5) goes up with each hit it lands. Every cast in it keeps its
     * own time (times).
     */
    recordCast(cast) {
        // Casting means you're alive, whatever we missed.
        if (this.playerDead) this.playerRevived();
        const p = this.powers ? this.powers.get(cast.powerId) : null;
        // The mount (Summon Mount, Dismount) and the procs the client fires by itself (Devour's
        // ProcDevour heal) are not part of the fight: no row, no cast, no place in the rotation.
        if (p && (p.mount || p.proc)) {
            return;
        }
        if (this._state !== 'running') {
            // A cast alone never starts the clock (auto-start waits for the first hit), but the
            // hit that starts it can be this cast's: see takeLeadIn.
            this.holdCast(cast, p);
            return;
        }
        this.addCast(cast, p);
    }

    /** A cast made while the clock is stopped, kept for a few seconds. */
    holdCast({ powerId, combo, projectile }, p) {
        const now = this.now();
        // A skill's follow-up is part of the cast that started it, not a cast of its own.
        const counted = !(p && p.followUp && !p.basicOverride);
        if (counted) this.ignored.casts += 1;
        this.held = this.held.filter((h) => now - h.at <= CAUSE_MS);
        this.held.push({ powerId, combo, projectile, ability: (p && p.abilityKey) || '', at: now, run: this.runId, counted });
        if (this.held.length > MAX_HELD) this.held.shift();
    }

    /**
     * A hit just started or restarted the clock. The casts that led to it were made while it was
     * stopped, a moment before (a cast reaches the meter before its hit does): the cast whose hit
     * this is (the latest cast of the power that hit, or of its skill), everything cast after it,
     * and anything cast in the 3 seconds before the hit. They are part of the fight, so they go
     * into the rotation, in order, at the moment the clock started; the hit counts for its cast.
     */
    takeLeadIn(where) {
        const now = this.now();
        const held = this.held.filter((h) => now - h.at <= CAUSE_MS);
        this.held = [];
        if (!held.length) return;
        const P = this.powers;
        const hp = P ? P.get(where.rowPowerId) : null;
        const ability = where.ability || (hp && hp.abilityKey && hp.ability && hp.ability[2] > 0 ? hp.abilityKey : '');
        let from = held.findIndex((h) => now - h.at <= LEAD_IN_MS);
        if (from < 0) from = held.length;
        for (let i = held.length - 1; i >= 0; i--) {
            const h = held[i];
            if (h.powerId === where.entryPowerId || (ability && h.ability === ability)) {
                from = Math.min(from, i);
                break;
            }
        }
        for (const h of held.slice(from)) {
            if (h.counted && h.run === this.runId && this.ignored.casts > 0) this.ignored.casts -= 1;
            this.addCast(h, P ? P.get(h.powerId) : null);
        }
    }

    /** A cast while the clock runs, into the rotation. */
    addCast({ powerId, combo, projectile }, p) {
        const kind = this.castKind(powerId, combo, projectile);
        const t = Math.round(this.elapsedMs());
        // A skill's follow-up (Mist Walk's closing strike, Charon's Blades' opening attack and its
        // end, Black Miasma's Shadow Tendril cloud) is part of the cast that started it, not
        // another press of the key.
        if (p && p.followUp && !p.basicOverride) {
            const parent = this.lastByKey.get(p.abilityKey);
            if (parent && t - parent.endT <= CAST_WINDOW_MS) {
                parent.endT = t;
                parent.powerIds.add(powerId);
                this.lastCast.set(powerId, parent);
                this.emit('change');
            }
            return;
        }
        const row = this.rowFor(powerId);
        // A skill's version of the basic attacks is a basic attack, not another cast of the skill.
        if (!(p && p.basicOverride)) row.casts += 1;
        this.totals.casts += 1;
        const last = this.rotation[this.rotation.length - 1];
        if ((kind === 'melee' || kind === 'ranged') && last && last.kind === kind && !last.closed) {
            last.casts += 1;
            last.endT = t;
            last.times.push(t);
            last.powerIds.add(powerId);
            this.lastCast.set(powerId, last);
            if (p && p.basicOverride) this.lastOverride.set(p.abilityKey, last);
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
            label: p && p.basicOverride ? row.label + (kind === 'ranged' ? ' ranged attacks' : ' melee attacks') : row.label,
            rank: p && p.rank ? p.rank : 0,
            casts: 1,
            times: [t], // when each of its casts was made
            closed: false, // a run of basic attacks ends when the clock stops
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
        if (p && p.basicOverride) this.lastOverride.set(p.abilityKey, entry);
        else this.lastByKey.set(row.key, entry);
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

    /** The Rotation window's entries (the latest `limit`, all with 0); `withTimes` adds each cast's time. */
    rotationView(limit, withTimes) {
        const list = this.rotationEntries();
        const shown = limit ? list.slice(-limit) : list;
        return {
            count: list.length,
            casts: list.reduce((n, e) => n + e.casts, 0),
            text: list.filter((e) => e.kind !== 'other').map((e) => this.badge(e)).join(' '),
            entries: shown.map((e) => {
                const v = {
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
                };
                if (withTimes) v.times = e.times.slice();
                return v;
            })
        };
    }

    /* ---------- output ---------- */

    rowView(row, total, seconds) {
        const scan = this.scanAbilities[row.key] || null;
        const P = this.powers;
        const ranks = Array.from(row.ranks).sort((a, b) => a - b);
        // A skill's row describes the skill (Charon's Blades), not whichever of its powers hit last.
        const p = P ? (row.ability ? P.mainPower(row.ability, ranks[ranks.length - 1]) : null) || P.get(row.lastPowerId) : null;
        const slot = P && row.ability ? P.slotOf(row.ability) : p && p.ability && p.ability[2] > 0 ? p.ability[2] : 0;
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
            scaling: p && p.carriesHit ? this.procScaling(row, p) : scan && scan.scalingText ? scan.scalingText : p && p.scaling.text ? p.scaling.text : '',
            // A proc's damage by the spell whose hit set it off, biggest first.
            triggers: row.triggers
                ? Array.from(row.triggers.values())
                      .sort((a, b) => b.damage - a.damage || b.procs - a.procs)
                      .map((t) => ({ key: t.key, label: t.label, damage: Math.round(t.damage), share: row.damage ? t.damage / row.damage : 0, procs: t.procs, crits: t.crits }))
                : [],
            description: scan && scan.description ? scan.description : p ? p.description : '',
            damageType: p ? p.damageType : '',
            powerIds: Array.from(row.powerIds),
            powerKey: row.ability || (p ? p.abilityKey || p.group || String(p.name || '').replace(/\d+$/, '') : ''),
            slot,
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
                        key: e.group, label: e.label, ability: '', ranks: new Set(e.rank ? [e.rank] : []), powerIds: new Set(), lastPowerId: 0,
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
        // Other damage is damage: a power that did none (a helper, a buff) isn't listed.
        const others = Array.from(views.values())
            .filter((r) => r.damage > 0)
            .sort((a, b) => b.damage - a.damage || b.casts - a.casts);
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
            dpsSeries: this.dpsSeries(),
            dungeon: this.dungeonView()
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
            rotation: this.rotationView(0, true).entries,
            stoppedAt: this.stoppedAt
        };
    }
}

module.exports = { DpsMeter, initials, isBasicPower, SLOT_KEYS, CHARON, DUNGEON_IDLE_MS, LEAD_IN_MS };
