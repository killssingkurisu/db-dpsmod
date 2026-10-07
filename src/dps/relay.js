'use strict';

const net = require('net');
const { EventEmitter } = require('events');
const P = require('./protocol');

/**
 * Follows one game connection and turns its packets into the player's casts and damage.
 *
 * Entity ids are the client's own numbering on both directions of one connection (the server
 * translates for each viewer), so everything is kept per connection. The player's body is the
 * entity the client reports with isPlayer set (0x08); its summons are the entities the client
 * reports with that body (or another of its summons) as summoner.
 */
class CombatTracker extends EventEmitter {
    constructor(label) {
        super();
        this.label = label;
        this.ownId = 0;
        this.characterName = '';
        this.summons = new Map(); // id -> { name, powerId }
        this.entities = new Map(); // id -> { name, isPlayer, team }
        this.recentDots = []; // [at, targetId, powerId, amount] sent by this client, to skip echoes
        this.packets = { up: 0, down: 0 };
        this.dummyTicksKept = 0;
    }

    isOwnSource(id) {
        return id !== 0 && (id === this.ownId || this.summons.has(id));
    }

    isFriendlyTarget(id) {
        if (id === this.ownId || this.summons.has(id)) {
            return true;
        }
        const e = this.entities.get(id);
        return Boolean(e && (e.isPlayer || e.team === P.TEAM.PLAYER));
    }

    targetName(id) {
        const e = this.entities.get(id);
        return e ? e.name : '';
    }

    /** Reads one packet from the client. Returns 'drop' for a packet that must not reach the server. */
    fromClient(id, payload) {
        this.packets.up += 1;
        switch (id) {
            case P.PKT.ENT_FULL_UPDATE: {
                const e = P.parseEntityFullUpdate(payload);
                this.entities.set(e.id, { name: e.name, isPlayer: e.isPlayer, team: e.team });
                if (e.isPlayer) {
                    if (this.ownId !== e.id || this.characterName !== e.name) {
                        this.ownId = e.id;
                        this.characterName = e.name;
                        this.emit('character', { id: e.id, name: e.name });
                    }
                } else if (e.summonerId && this.isOwnSource(e.summonerId)) {
                    this.summons.set(e.id, { name: e.name, powerId: e.powerId });
                }
                break;
            }
            case P.PKT.POWER_CAST: {
                const c = P.parsePowerCast(payload);
                if (c.sourceId && c.sourceId === this.ownId) {
                    this.emit('cast', { powerId: c.powerId, combo: c.combo, projectile: c.projectileId !== null });
                }
                break;
            }
            case P.PKT.POWER_HIT: {
                const h = P.parsePowerHit(payload);
                if (h.damage > 0 && this.isOwnSource(h.sourceId) && !this.isFriendlyTarget(h.targetId)) {
                    const ev = this.damageEvent('hit', h.sourceId, h.powerId, h.damage, h.isCrit, h.targetId);
                    // A proc's hit (Charon's Blades' ProcCriticalHit, a glancing blow) names the power
                    // that set it off in its first optional id: ActivePower.var_249, written by
                    // LinkUpdater.method_1092. See DpsMeter.resolve.
                    if (h.animOverrideId && h.animOverrideId !== h.powerId) ev.originId = h.animOverrideId;
                    this.emit('damage', ev);
                }
                break;
            }
            case P.PKT.BUFF_TICK_DOT: {
                const d = P.parseBuffTickDot(payload);
                if (d.amount !== 0 && this.isOwnSource(d.sourceId) && !this.isFriendlyTarget(d.targetId)) {
                    const now = Date.now();
                    this.recentDots.push([now, d.targetId, d.powerId, Math.abs(d.amount)]);
                    if (this.recentDots.length > 64) this.recentDots.shift();
                    this.emit('damage', this.damageEvent('dot', d.sourceId, d.powerId, Math.abs(d.amount), false, d.targetId));
                }
                // An unmodified client never sends ticks on a training dummy; the patched one does so
                // the meter can count them, and they stop here.
                if (this.isDummy(d.targetId)) {
                    this.dummyTicksKept += 1;
                    return 'drop';
                }
                break;
            }
            default:
                break;
        }
        return undefined;
    }

    /** The house training dummies (behaviour HomeDummy: entity types HomeDummy1-3). */
    isDummy(id) {
        const e = this.entities.get(id);
        return Boolean(e && /^HomeDummy/.test(e.name));
    }

    fromServer(id, payload) {
        this.packets.down += 1;
        switch (id) {
            case P.PKT.NEWLY_RELEVANT_ENTITY: {
                const e = P.parseNewlyRelevantEntity(payload);
                this.entities.set(e.id, { name: e.name, isPlayer: e.isPlayer, team: e.team });
                break;
            }
            case P.PKT.ENTER_WORLD: {
                this.emit('enterWorld', P.parseEnterWorld(payload));
                break;
            }
            case P.PKT.BUFF_TICK_DOT: {
                // A DoT of ours ticking on a mob another party member's client runs comes back
                // from the server instead of going out from ours.
                const d = P.parseBuffTickDot(payload);
                const amount = Math.abs(d.amount);
                if (!amount || !this.isOwnSource(d.sourceId) || this.isFriendlyTarget(d.targetId)) {
                    break;
                }
                const now = Date.now();
                const echo = this.recentDots.findIndex(
                    (r) => now - r[0] < 1500 && r[1] === d.targetId && r[2] === d.powerId && r[3] === amount
                );
                if (echo >= 0) {
                    this.recentDots.splice(echo, 1);
                    break;
                }
                this.emit('damage', this.damageEvent('dot', d.sourceId, d.powerId, amount, false, d.targetId));
                break;
            }
            default:
                break;
        }
    }

    damageEvent(kind, sourceId, powerId, damage, crit, targetId) {
        const summon = sourceId !== this.ownId ? this.summons.get(sourceId) || null : null;
        return {
            kind,
            powerId: summon && !powerId ? summon.powerId : powerId,
            damage,
            crit: Boolean(crit),
            targetId,
            targetName: this.targetName(targetId),
            summon
        };
    }
}

const POLICY =
    '<?xml version="1.0"?><!DOCTYPE cross-domain-policy SYSTEM "/xml/dtds/cross-domain-policy.dtd">' +
    '<cross-domain-policy><site-control permitted-cross-domain-policies="master-only"/>' +
    '<allow-access-from domain="*" to-ports="*"/></cross-domain-policy>\0';

/** Flash asks "<policy-file-request/>" before it opens a socket; null while the request is incomplete. */
function policyRequest(buf) {
    if (!buf.length || buf[0] !== 0x3c) return false;
    const end = buf.indexOf(0);
    if (end < 0) return buf.length > 1024 ? false : null;
    return /^<policy-file-request\/>/.test(buf.toString('latin1', 0, end));
}

function isLoopback(host) {
    return /^(127\.|localhost$|::1$)/i.test(String(host || ''));
}

/**
 * A loopback TCP relay for one game server address.
 *
 * Client to server, bytes are forwarded as they arrive and a copy is read. Server to client,
 * whole packets are forwarded, so that "enter world" (0x21), which names the server the client
 * reconnects to, can point the client at the relay for that server instead (see RelayHub).
 * Everything else reaches the client exactly as the server sent it. Flash's socket-policy
 * question is answered here and never reaches the server.
 */
class GameRelay extends EventEmitter {
    constructor({ listenPort, upstreamHost, upstreamPort, rewriteTarget }) {
        super();
        this.listenPort = listenPort;
        this.upstreamHost = upstreamHost;
        this.upstreamPort = upstreamPort;
        this.rewriteTarget = rewriteTarget || null;
        this.server = null;
        this.listening = false;
        this.error = '';
        this.connections = 0;
        this.policyAnswers = 0;
        this.dummyTicksKept = 0;
        this.open = new Set();
        this.lastPacketAt = 0;
        this.seq = 0;
    }

    get label() {
        return this.upstreamHost + ':' + this.upstreamPort;
    }

    listen() {
        return new Promise((resolve) => {
            const server = net.createServer((client) => this.accept(client));
            server.once('error', (err) => {
                this.error = String((err && err.code) || (err && err.message) || err);
                this.listening = false;
                this.emit('status');
                resolve(false);
            });
            server.listen(this.listenPort, '127.0.0.1', () => {
                this.server = server;
                this.listenPort = server.address().port;
                this.listening = true;
                this.error = '';
                this.emit('status');
                resolve(true);
            });
        });
    }

    close() {
        for (const pair of this.open) {
            pair.client.destroy();
            pair.upstream.destroy();
        }
        this.open.clear();
        if (this.server) {
            this.server.close();
            this.server = null;
        }
        this.listening = false;
    }

    accept(client) {
        client.setNoDelay(true);
        let first = Buffer.alloc(0);
        let decided = false;
        const onError = () => client.destroy();
        const decide = (policy) => {
            decided = true;
            clearTimeout(timer);
            client.removeListener('data', onFirst);
            client.removeListener('error', onError);
            if (policy) {
                this.policyAnswers += 1;
                client.on('error', () => {});
                client.end(POLICY);
                return;
            }
            this.pipe(client, first);
        };
        const onFirst = (chunk) => {
            first = Buffer.concat([first, chunk]);
            const policy = policyRequest(first);
            if (policy !== null) decide(policy);
        };
        // Flash asks for the policy the moment it connects; a client that says nothing at first
        // is connected through anyway, in case the server speaks first.
        const timer = setTimeout(() => {
            if (!decided && !client.destroyed) decide(false);
        }, 400);
        client.on('data', onFirst);
        client.on('error', onError);
        client.on('close', () => clearTimeout(timer));
    }

    pipe(client, first) {
        const upstream = net.connect({ host: this.upstreamHost, port: this.upstreamPort });
        upstream.setNoDelay(true);
        const tracker = new CombatTracker(this.label + '#' + ++this.seq);
        const pair = { client, upstream, tracker, up: Buffer.alloc(0), rawUp: false, down: Buffer.alloc(0), pumping: false, rawDown: false, closed: false };
        this.open.add(pair);
        this.connections += 1;
        this.emit('connection', tracker);
        this.emit('status');

        const forwardUp = (chunk) => {
            if (!chunk.length) return;
            pair.up = pair.up.length ? Buffer.concat([pair.up, chunk]) : chunk;
            const out = this.takeUp(pair);
            if (out.length && !upstream.write(out)) client.pause();
        };
        forwardUp(first);
        client.on('data', forwardUp);
        upstream.on('drain', () => client.resume());
        upstream.on('data', (chunk) => {
            if (pair.rawDown) {
                this.toClient(pair, chunk);
                return;
            }
            pair.down = pair.down.length ? Buffer.concat([pair.down, chunk]) : chunk;
            this.pumpDown(pair);
        });
        client.on('drain', () => upstream.resume());

        const finish = () => {
            if (pair.closed) return;
            pair.closed = true;
            this.open.delete(pair);
            client.destroy();
            upstream.destroy();
            tracker.emit('closed');
            this.emit('status');
        };
        // When the server closes (it does after sending the client elsewhere), everything already
        // read still goes to the client, including an enter-world packet waiting on a new relay.
        let upstreamDone = false;
        const endClient = () => {
            if (upstreamDone) return;
            upstreamDone = true;
            const go = () => {
                if (pair.closed) return;
                if (pair.pumping) {
                    setTimeout(go, 5);
                    return;
                }
                client.end(pair.down.length ? pair.down : undefined);
                const t = setTimeout(finish, 5000);
                if (t.unref) t.unref();
            };
            go();
        };
        client.on('end', () => upstream.end());
        client.on('close', finish);
        client.on('error', finish);
        upstream.on('end', endClient);
        upstream.on('close', endClient);
        upstream.on('error', (err) => {
            this.error = String((err && err.message) || err);
            endClient();
        });
    }

    /**
     * Complete packets waiting in pair.up, ready for the server: everything the client sent, in
     * order, less the training-dummy DoT ticks the tracker keeps (see CombatTracker.fromClient).
     * An incomplete packet waits for the rest of its bytes.
     */
    takeUp(pair) {
        if (pair.rawUp) {
            const all = pair.up;
            pair.up = Buffer.alloc(0);
            return all;
        }
        const out = [];
        let kept = 0;
        for (;;) {
            const b = pair.up;
            if (b.length && b[0] === 0x3c) {
                // Not a game packet (a second policy request?): from here on, bytes pass as they are.
                pair.rawUp = true;
                out.push(b);
                pair.up = Buffer.alloc(0);
                break;
            }
            if (b.length < 4) break;
            const len = b.readUInt16BE(2);
            if (b.length < 4 + len) break;
            const id = b.readUInt16BE(0);
            const whole = b.subarray(0, 4 + len);
            pair.up = b.subarray(4 + len);
            this.lastPacketAt = Date.now();
            let verdict;
            try {
                verdict = pair.tracker.fromClient(id, whole.subarray(4));
            } catch (_e) {
                verdict = undefined; // a packet we misread still goes to the server
            }
            if (verdict === 'drop') {
                kept += 1;
                continue;
            }
            out.push(whole);
        }
        if (kept) this.dummyTicksKept += kept;
        return out.length === 1 ? out[0] : Buffer.concat(out);
    }

    toClient(pair, buf) {
        if (pair.closed || !buf.length) return;
        if (!pair.client.write(buf)) pair.upstream.pause();
    }

    /** Forwards every complete packet waiting in pair.down, in order, rewriting 0x21 on the way. */
    async pumpDown(pair) {
        if (pair.pumping) return;
        pair.pumping = true;
        try {
            for (;;) {
                const out = [];
                let enter = null;
                for (;;) {
                    const b = pair.down;
                    if (b.length && b[0] === 0x3c) {
                        // a policy answer, ended by a NUL byte (not expected from a game server)
                        const end = b.indexOf(0);
                        if (end < 0) {
                            if (b.length > 4096) {
                                pair.rawDown = true;
                                out.push(b);
                                pair.down = Buffer.alloc(0);
                            }
                            break;
                        }
                        out.push(b.subarray(0, end + 1));
                        pair.down = b.subarray(end + 1);
                        continue;
                    }
                    if (b.length < 4) break;
                    const len = b.readUInt16BE(2);
                    if (b.length < 4 + len) break;
                    const id = b.readUInt16BE(0);
                    const whole = b.subarray(0, 4 + len);
                    pair.down = b.subarray(4 + len);
                    this.lastPacketAt = Date.now();
                    try {
                        pair.tracker.fromServer(id, whole.subarray(4));
                    } catch (_e) {
                        // a packet we misread is still forwarded as it is
                    }
                    if (id === P.PKT.ENTER_WORLD && this.rewriteTarget) {
                        enter = whole;
                        break;
                    }
                    out.push(whole);
                }
                if (out.length) this.toClient(pair, out.length === 1 ? out[0] : Buffer.concat(out));
                if (!enter) break;
                this.toClient(pair, await this.redirect(enter));
            }
        } finally {
            pair.pumping = false;
        }
    }

    /** Points an enter-world packet at the relay for the server it names. */
    async redirect(whole) {
        let world = null;
        try {
            world = P.parseEnterWorld(whole.subarray(4));
        } catch (_e) {
            return whole;
        }
        const from = world.host + ':' + world.port;
        let target = null;
        try {
            target = await this.rewriteTarget(world.host, world.port);
        } catch (_e) {
            target = null;
        }
        if (!target) {
            this.emit('redirect', { from, to: '', ok: false, level: world.level });
            return whole;
        }
        if (target.unchanged) {
            this.emit('redirect', { from, to: from, ok: true, level: world.level });
            return whole;
        }
        try {
            const r = P.rewriteEnterWorld(whole.subarray(4), target.host, target.port);
            this.emit('redirect', { from, to: target.host + ':' + target.port, ok: true, level: world.level });
            return P.frame(P.PKT.ENTER_WORLD, r.payload);
        } catch (_e) {
            this.emit('redirect', { from, to: '', ok: false, level: world.level });
            return whole;
        }
    }

    status() {
        return {
            target: this.label,
            listenPort: this.listenPort,
            listening: this.listening,
            error: this.error,
            connections: this.connections,
            open: this.open.size,
            lastPacketAt: this.lastPacketAt
        };
    }
}

/**
 * Every game server the client talks to gets its own relay on 127.0.0.1. The login server's
 * relay is the one the patched DungeonBlitz.swf connects to; each "enter world" packet then
 * names the next server, and the relay it passes through swaps in the relay for that server.
 *
 * Relay ports come from a low range because the login port replaces a two-byte operand in the
 * SWF (below 16384). The hub also answers Flash's socket-policy question on port 843, which
 * Flash asks before trying the game port itself.
 */
class RelayHub extends EventEmitter {
    constructor({ portBase = 13690, portLast = 13989, policyPort = 843 } = {}) {
        super();
        this.portBase = portBase;
        this.portLast = portLast;
        this.nextPort = portBase;
        this.policyPort = policyPort;
        this.policyServer = null;
        this.policyError = '';
        this.policyAnswers = 0;
        this.relays = new Map();
        this.pending = new Map();
        this.closed = false;
    }

    static key(host, port) {
        return String(host).toLowerCase() + ':' + Number(port);
    }

    get all() {
        return Array.from(this.relays.values());
    }

    find(host, port) {
        return this.relays.get(RelayHub.key(host, port)) || null;
    }

    relayFor(host, port) {
        const key = RelayHub.key(host, port);
        if (this.relays.has(key)) return Promise.resolve(this.relays.get(key));
        if (this.pending.has(key)) return this.pending.get(key);
        const p = this.create(String(host).toLowerCase(), Number(port)).finally(() => this.pending.delete(key));
        this.pending.set(key, p);
        return p;
    }

    async create(host, port) {
        if (this.closed) throw new Error('closed');
        const relay = new GameRelay({
            listenPort: 0,
            upstreamHost: host,
            upstreamPort: port,
            rewriteTarget: (h, p) => this.target(h, p)
        });
        let lastError = '';
        const any = this.portBase === 0; // tests: any free port
        while (any || this.nextPort <= this.portLast) {
            relay.listenPort = any ? 0 : this.nextPort++;
            const ok = await relay.listen();
            if (!ok && any) {
                lastError = relay.error;
                break;
            }
            if (ok) {
                this.relays.set(RelayHub.key(host, port), relay);
                relay.on('connection', (tracker) => this.emit('connection', relay, tracker));
                relay.on('redirect', (info) => this.emit('redirect', relay, info));
                relay.on('status', () => this.emit('status'));
                this.emit('relay', relay);
                this.emit('status');
                return relay;
            }
            lastError = relay.error;
        }
        throw new Error('no free port between ' + this.portBase + ' and ' + this.portLast + (lastError ? ' (' + lastError + ')' : ''));
    }

    /** Where a client sent to host:port should connect instead. */
    async target(host, port) {
        if (isLoopback(host) && this.all.some((r) => r.listenPort === Number(port))) {
            return { host, port, unchanged: true }; // already one of ours
        }
        const relay = await this.relayFor(host, port);
        return { host: '127.0.0.1', port: relay.listenPort };
    }

    startPolicyServer() {
        return new Promise((resolve) => {
            const server = net.createServer((sock) => {
                let buf = Buffer.alloc(0);
                sock.on('error', () => sock.destroy());
                sock.setTimeout(5000, () => sock.destroy());
                sock.on('data', (d) => {
                    buf = Buffer.concat([buf, d]);
                    const policy = policyRequest(buf);
                    if (policy === null) return;
                    if (policy) this.policyAnswers += 1;
                    sock.end(policy ? POLICY : undefined);
                });
            });
            server.once('error', (err) => {
                this.policyError = String((err && err.code) || (err && err.message) || err);
                resolve(false);
            });
            server.listen(this.policyPort, '127.0.0.1', () => {
                this.policyServer = server;
                resolve(true);
            });
        });
    }

    close() {
        this.closed = true;
        for (const r of this.relays.values()) r.close();
        this.relays.clear();
        if (this.policyServer) {
            this.policyServer.close();
            this.policyServer = null;
        }
    }
}

module.exports = { GameRelay, RelayHub, CombatTracker, POLICY, policyRequest, isLoopback };
