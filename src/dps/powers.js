'use strict';

const { unpackSwz, chunkByRoot } = require('./swz');

/**
 * Power id -> what the meter needs to name and classify a hit.
 *
 * Built from the game's own data (PlayerPowerTypes, MonsterPowerTypes and AbilityTypes inside
 * Game.swz), so a rank-10 Poison Strike hit (power 993) reads as "Poison Strike", rank 10, with
 * "[Stats: 1.49x attack, 2x Expertise/s (5s), ...]": the direct hit scales with Attack and the
 * poison with Expertise.
 */

const STAT_RE = /(\d+(?:\.\d+)?)x\s*(attack|expertise|heal)(\/s)?(?:\s*\((\d+(?:\.\d+)?)s\))?/gi;

function tag(block, name) {
    const m = block.match(new RegExp('<' + name + '>([\\s\\S]*?)</' + name + '>'));
    if (!m) {
        return '';
    }
    const v = m[1].trim();
    return v === '----' ? '' : decodeEntities(v);
}

function decodeEntities(s) {
    return s
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'")
        .replace(/&#(\d+);/g, (_m, n) => String.fromCharCode(Number(n)))
        .replace(/&amp;/g, '&');
}

/**
 * Raw records, compact: [id, name, base, display, damageType, mana, cooldownMs, description,
 * isMonster, targetMethod, powerGroup, spawnedMonsters].
 */
function parsePowerXml(xml, isMonster) {
    const out = [];
    const re = /<Power PowerName="([^"]+)">([\s\S]*?)<\/Power>/g;
    let m;
    while ((m = re.exec(xml))) {
        const id = Number(tag(m[2], 'PowerID'));
        if (!Number.isFinite(id) || id <= 0) {
            continue;
        }
        const base = tag(m[2], 'BasePowerName');
        out.push([
            id,
            m[1],
            base === m[1] ? '' : base,
            tag(m[2], 'DisplayName'),
            tag(m[2], 'DamageType'),
            tag(m[2], 'ManaCost'),
            Number(tag(m[2], 'CoolDownTime')) || 0,
            tag(m[2], 'Description'),
            isMonster ? 1 : 0,
            tag(m[2], 'TargetMethod'),
            tag(m[2], 'PowerGroup'),
            tag(m[2], 'SpawnedMonsters')
        ]);
    }
    return out;
}

/** AbilityName -> [class, category, hotbarLocation, maxRank]. */
function parseAbilityXml(xml) {
    const out = {};
    const re = /<Ability(?: AbilityName="([^"]*)")?>([\s\S]*?)<\/Ability>/g;
    let m;
    let current = null;
    while ((m = re.exec(xml))) {
        if (m[1]) {
            current = m[1] === 'Template' ? null : m[1];
            if (current) {
                out[current] = [tag(m[2], 'Class'), tag(m[2], 'Category'), Number(tag(m[2], 'HotbarLocation')) || 0, 1];
            }
            continue;
        }
        if (current) {
            const rank = Number(tag(m[2], 'Rank')) || 0;
            if (rank > out[current][3]) {
                out[current][3] = rank;
            }
        }
    }
    return out;
}

/**
 * The data set's layout version. 2 added SpawnedMonsters (which spell a summon belongs to); a
 * cached table older than this is rebuilt from Game.swz.
 */
const DATA_VERSION = 2;

/**
 * LevelName -> [displayName, isDungeon]. A dungeon has a rankings board (RankingsURL); towns and
 * the open zones don't (CraftTown, NewbieRoad "Wolf's End", SwampRoadNorth "Black Rose Mire").
 */
function parseLevelXml(xml) {
    const out = {};
    const re = /<LevelType LevelName="([^"]+)">([\s\S]*?)<\/LevelType>/g;
    let m;
    while ((m = re.exec(xml || ''))) {
        out[m[1]] = [tag(m[2], 'DisplayName'), tag(m[2], 'RankingsURL') ? 1 : 0];
    }
    return out;
}

/** The compact data set a table is built from: what powers-snapshot.json holds. */
function dataFromSwz(buf, source) {
    const chunks = unpackSwz(buf);
    const player = chunkByRoot(chunks, 'PlayerPowerTypes');
    if (!player) {
        throw new Error('Game.swz has no PlayerPowerTypes');
    }
    return {
        version: DATA_VERSION,
        source: source || 'Game.swz',
        builtAt: new Date().toISOString(),
        powers: parsePowerXml(player, false).concat(parsePowerXml(chunkByRoot(chunks, 'MonsterPowerTypes'), true)),
        abilities: parseAbilityXml(chunkByRoot(chunks, 'AbilityTypes')),
        levels: parseLevelXml(chunkByRoot(chunks, 'LevelTypes'))
    };
}

/** "Stats" terms of a description: the part before "| Next rank". */
function parseScaling(description) {
    const out = { hit: null, dot: null, heal: false, terms: [] };
    const m = /\[Stats:([^\]]*)\]/i.exec(description || '');
    if (!m) {
        return out;
    }
    const current = m[1].split('|')[0];
    out.text = current.trim();
    let t;
    STAT_RE.lastIndex = 0;
    while ((t = STAT_RE.exec(current))) {
        const term = {
            mult: Number(t[1]),
            stat: t[2].toLowerCase(),
            perSecond: Boolean(t[3]),
            seconds: t[4] ? Number(t[4]) : 0
        };
        out.terms.push(term);
        if (term.stat === 'heal') {
            out.heal = true;
            continue;
        }
        if (term.perSecond) {
            if (!out.dot) out.dot = term;
        } else if (!out.hit) {
            out.hit = term;
        }
    }
    return out;
}

function prettify(name) {
    return String(name || '')
        .replace(/\d+$/, '')
        .replace(/([a-z])([A-Z])/g, '$1 $2')
        .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
        .trim();
}

/** How a basic attack picks its target: melee combos and punches, thrown and shot projectiles. */
const MELEE_METHOD = /^(MeleeCombo|MeleePunch)$/;
const BASIC_METHOD = /^(MeleeCombo|MeleePunch|ProjectilePlayer|ProjectileCombo)$/;

/**
 * Powers that only ever ride on another power's hit: Charon's Blades turns every hit into a
 * ProcCriticalHit, a glancing blow halves one into a ProcGlancingBlow, Devour and Shadow Scythe
 * heal through ProcDevour, gear and runes fire their own. The client fires them itself
 * (CombatState.method_72); they are never a key the player pressed.
 */
function isProc(name, display) {
    return /^(Proc|SigilProc)/.test(name) || /MonsterProc/.test(display || '');
}

/** The mount: Summon Mount (whatever its display name says) and Dismount. No damage, no rotation. */
function isMount(name, targetMethod) {
    return name === 'SummonMount' || name === 'Dismount' || targetMethod === 'Mount';
}

/**
 * Rune procs whose damage is the critical hit that set them off, not a stat of their own. Every
 * hit of a spell, and a basic attack's combo finisher (a basic attack's ProcModifier is 0),
 * rolls the player's critical chance (CombatState.method_1200; ProcChance, which the data's
 * Steadiness talent calls CritChance: 15% to start with). A critical hit hands every rune proc
 * half its final damage (method_72(proc, ..., damage / 2, powerId)); these powers
 * (PowerType.var_470) multiply that by 1 + their bonus and deal it: the elemental runes and
 * Heavy Blow as a hit, Hemorrhage as a bleed.
 */
const CARRIED_PROCS = new Set(['ProcFire', 'ProcIce', 'ProcDeath', 'ProcLife', 'ProcEarth', 'ProcAir', 'ProcMassive', 'ProcMassiveTime']);
/**
 * Hemorrhage's bleed (ProcMassiveTimeBuff, BuffType.var_2424) takes that damage as its size, not
 * the caster's Expertise, and a new one on a bleeding target adds to what is left of the old one
 * (Buff: size - paid so far + new), then ticks over again.
 */
const POOLED_PROCS = new Set(['ProcMassiveTime']);

class PowerTable {
    constructor(data) {
        this.data = data;
        this.byId = new Map();
        this.abilities = data.abilities || {};
        this.levels = data.levels || {};
        for (const r of data.powers || []) {
            const [id, name, base, display, damageType, mana, cooldown, description, monster, targetMethod, powerGroup, spawned] = r;
            const group = base || name;
            // The ability a power belongs to. Usually its own base name (PoisonStrike10 ->
            // PoisonStrike); a skill's follow-up powers name it in PowerGroup instead: Mist Walk's
            // MistWalkClose10, Charon's Blades' SeekingBladesAttack10 and EndSeekingBlades.
            // A legendary item's rune for a skill is a power too (LegendaryMistWalk: Mist Walk adds
            // 3 Bleed), and the damage it adds counts for that skill.
            const legendary = /^Legendary(.+)$/.exec(name);
            const abilityKey = this.abilities[group]
                ? group
                : legendary && this.abilities[legendary[1]]
                  ? legendary[1]
                  : powerGroup && this.abilities[powerGroup]
                    ? powerGroup
                    : '';
            let rank = 0;
            if (base && name.startsWith(base)) {
                const n = Number(name.slice(base.length));
                rank = Number.isFinite(n) ? n : 0;
            }
            const scaling = parseScaling(description);
            // Monster powers are all called "***Monster***" in the data, procs "***MonsterProc***".
            const placeholder = /^\*+.*\*+$/.test(display || '');
            const manaFree = /^0(,|$)/.test(String(mana || '').trim());
            const onHotbar = Boolean(abilityKey && this.abilities[abilityKey] && this.abilities[abilityKey][2] > 0);
            const basicMelee = !monster && !onHotbar && manaFree && MELEE_METHOD.test(targetMethod || '');
            this.byId.set(id, {
                id,
                name,
                group,
                rank,
                // Your own melee basic attack is just "Melee" (Dagger Melee, Sword Melee, Staff Melee, ...).
                label: basicMelee ? 'Melee' : (!placeholder && display) || prettify(name) || name,
                damageType: damageType || '',
                mana: String(mana || ''),
                cooldownMs: cooldown,
                description: description || '',
                scaling,
                monster: Boolean(monster),
                // How the power picks its target: MeleeCombo for melee basic attacks,
                // ProjectilePlayer / ProjectileCombo for ranged ones, Self, RangedAoE, ...
                targetMethod: targetMethod || '',
                powerGroup: powerGroup || '',
                spawned: String(spawned || '')
                    .split(',')
                    .map((x) => x.trim())
                    .filter(Boolean),
                abilityKey,
                followUp: Boolean(abilityKey && abilityKey !== group),
                ability: abilityKey ? this.abilities[abilityKey] : null,
                basicMelee,
                proc: !monster && isProc(name, display),
                // A share of the hit that set it off (Hemorrhage, the elemental runes, Heavy Blow).
                carriesHit: !monster && CARRIED_PROCS.has(name),
                pooled: !monster && POOLED_PROCS.has(name),
                mount: isMount(name, targetMethod),
                basicOverride: false
            });
        }

        // A hotbar skill's other powers often share its PowerGroup under another name: Hailstone
        // Embrace (PowerGroup FrostArmor) owns Frost Armor Ice, Frost Armor Melee / Ranged (the
        // basic attacks it enchants) and End Hailstone Embrace; Black Miasma (ShadowTendrilDash,
        // PowerGroup ShadowTendril) owns the Shadow Tendril cloud. Only groups that belong to one
        // hotbar skill count (a basic-attack ability such as Frost Bolt keeps its Iceball).
        const owner = new Map();
        for (const p of this.byId.values()) {
            if (!p.abilityKey || p.followUp || !p.powerGroup || !(p.ability && p.ability[2] > 0)) continue;
            const prev = owner.get(p.powerGroup);
            owner.set(p.powerGroup, prev === undefined || prev === p.abilityKey ? p.abilityKey : null);
        }
        for (const p of this.byId.values()) {
            if (p.abilityKey || p.monster || p.proc || p.mount || !p.powerGroup) continue;
            const key = owner.get(p.powerGroup);
            if (!key) continue;
            p.abilityKey = key;
            p.followUp = true;
            p.ability = this.abilities[key];
            p.basicMelee = false;
        }
        for (const p of this.byId.values()) {
            // A skill's version of the basic attacks (Hailstone Embrace's Frost Armor Melee and
            // Ranged): pressed like any basic attack, damage for the skill.
            p.basicOverride = Boolean(p.followUp && p.ability && p.ability[2] > 0 && BASIC_METHOD.test(p.targetMethod));
        }

        // An ability's name, from its own powers (follow-ups often have none, or another).
        const names = {};
        for (const p of this.byId.values()) {
            if (p.abilityKey && !p.followUp && !names[p.abilityKey]) names[p.abilityKey] = p.label;
        }
        this.abilityNames = names;
        for (const p of this.byId.values()) {
            p.abilityLabel = p.abilityKey ? names[p.abilityKey] || p.label : p.label;
        }

        // Which skill each summon belongs to: Shadow Legion spawns ShadowLegionClone10, ...
        this.spawnedBy = new Map();
        for (const p of this.byId.values()) {
            if (!p.abilityKey) continue;
            for (const m of p.spawned) {
                if (!this.spawnedBy.has(m)) this.spawnedBy.set(m, p.abilityKey);
                const bare = m.replace(/\d+$/, '');
                if (!this.spawnedBy.has(bare)) this.spawnedBy.set(bare, p.abilityKey);
            }
        }
    }

    get(id) {
        return this.byId.get(id) || null;
    }

    /**
     * A level's name as the game shows it ("GoblinRiverDungeon" -> "Goblin Camp"), and whether it's a
     * dungeon. Hard versions share their dungeon's entry.
     */
    levelInfo(name) {
        const n = String(name || '');
        const l = this.levels[n] || this.levels[n.replace(/Hard$/, '')] || null;
        return { name: n, displayName: (l && l[0]) || prettify(n.replace(/Hard$/, '')) || n, dungeon: l ? Boolean(l[1]) : /Dungeon|Mission/i.test(n) };
    }

    /** An ability's display name ("SeekingBlades" -> "Charon's Blades"). */
    abilityLabel(key) {
        return this.abilityNames[key] || prettify(key);
    }

    /** An ability's hotbar slot (AbilityTypes HotbarLocation; 0 for basic-attack abilities). */
    slotOf(key) {
        const a = this.abilities[key];
        return a ? a[2] || 0 : 0;
    }

    /** The power that stands for an ability: its own power of the given rank, else its highest. */
    mainPower(key, rank) {
        let best = null;
        for (const p of this.byId.values()) {
            if (p.abilityKey !== key || p.followUp) continue;
            if (rank && p.rank === rank) return p;
            if (!best || p.rank > best.rank) best = p;
        }
        return best;
    }

    /**
     * The hotbar skill a summon's damage belongs to: the power that summoned it (the summon's 0x08
     * names it; Entity.var_99), else the skill whose SpawnedMonsters list its entity type.
     */
    summonAbility(summon) {
        if (!summon) return '';
        const by = summon.powerId ? this.get(summon.powerId) : null;
        if (by && by.abilityKey && !by.monster) return by.abilityKey;
        const name = String(summon.name || '');
        return this.spawnedBy.get(name) || this.spawnedBy.get(name.replace(/\d+$/, '')) || '';
    }

    /**
     * Which stat a hit scales with, by the client's own arithmetic (CombatState.method_1192): a
     * direct hit is BaseDamageMult x meleeDamage, that is Attack, whatever its DamageType (Ice,
     * Fire and Dark spells included: Bitter Blade, Frozen Ward, Frigid Comet). A DoT tick is
     * Expertise: every buff a power puts on its target carries the caster's magicDamage
     * (AddBuff(type, caster, caster.magicDamage, powerId)), Chilblains from Frigid Comet too.
     * The data agrees: of its Stats terms, every direct one is "Nx attack" and every per-second one
     * "Nx Expertise/s".
     *
     * Except a rune proc that carries the hit that set it off (CARRIED_PROCS): its damage is a
     * share of that hit, which is Attack, so it is Attack too, Hemorrhage's bleed ticks included
     * (its Stats line says Expertise/s, but the bleed's size is the hit's damage).
     */
    statFor(id, kind) {
        const p = this.get(id);
        if (p && p.carriesHit) return 'attack';
        return kind === 'dot' ? 'expertise' : 'attack';
    }

    get size() {
        return this.byId.size;
    }
}

module.exports = { PowerTable, dataFromSwz, parseScaling, parsePowerXml, parseAbilityXml, parseLevelXml, prettify, isProc, isMount, CARRIED_PROCS, POOLED_PROCS, DATA_VERSION };
