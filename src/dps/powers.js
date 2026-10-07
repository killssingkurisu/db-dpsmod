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
 * isMonster, targetMethod, powerGroup].
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
            tag(m[2], 'PowerGroup')
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

/** The compact data set a table is built from: what powers-snapshot.json holds. */
function dataFromSwz(buf, source) {
    const chunks = unpackSwz(buf);
    const player = chunkByRoot(chunks, 'PlayerPowerTypes');
    if (!player) {
        throw new Error('Game.swz has no PlayerPowerTypes');
    }
    return {
        version: 1,
        source: source || 'Game.swz',
        builtAt: new Date().toISOString(),
        powers: parsePowerXml(player, false).concat(parsePowerXml(chunkByRoot(chunks, 'MonsterPowerTypes'), true)),
        abilities: parseAbilityXml(chunkByRoot(chunks, 'AbilityTypes'))
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

class PowerTable {
    constructor(data) {
        this.data = data;
        this.byId = new Map();
        this.abilities = data.abilities || {};
        for (const r of data.powers || []) {
            const [id, name, base, display, damageType, mana, cooldown, description, monster, targetMethod, powerGroup] = r;
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
            this.byId.set(id, {
                id,
                name,
                group,
                rank,
                label: display || prettify(name) || name,
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
                abilityKey,
                followUp: Boolean(abilityKey && abilityKey !== group),
                ability: abilityKey ? this.abilities[abilityKey] : null
            });
        }
        // An ability's name, from its own powers (follow-ups often have none, or another).
        const names = {};
        for (const p of this.byId.values()) {
            if (p.abilityKey && !p.followUp && !names[p.abilityKey]) names[p.abilityKey] = p.label;
        }
        for (const p of this.byId.values()) {
            p.abilityLabel = p.abilityKey ? names[p.abilityKey] || p.label : p.label;
        }
    }

    get(id) {
        return this.byId.get(id) || null;
    }

    /**
     * Which stat a hit of this power scales with. A direct hit takes the first "Nx stat" term of
     * the Stats line; without one, physical powers scale with Attack and everything elemental
     * (Fire, Ice, Holy, Dark, ...) with Expertise. A DoT tick always scales with Expertise: the
     * client snapshots the caster's magicDamage (Expertise) into every buff a power puts on its
     * target (CombatState: AddBuff(type, caster, caster.magicDamage * (1 + mods), powerId)),
     * whatever the power's hit scales with.
     */
    statFor(id, kind) {
        if (kind === 'dot') {
            return 'expertise';
        }
        const p = this.byId.get(id);
        if (!p) {
            return 'unknown';
        }
        const term = p.scaling.hit;
        if (term) {
            return term.stat;
        }
        if (!p.damageType) {
            return 'unknown';
        }
        return /^physical$/i.test(p.damageType) ? 'attack' : 'expertise';
    }

    get size() {
        return this.byId.size;
    }
}

module.exports = { PowerTable, dataFromSwz, parseScaling, parsePowerXml, parseAbilityXml, prettify };
