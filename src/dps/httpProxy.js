'use strict';

const http = require('http');
const net = require('net');
const { EventEmitter } = require('events');

/** Headers that belong to one hop, not to the request or response being passed on. */
const HOP = ['connection', 'keep-alive', 'proxy-connection', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade'];

function withoutHop(headers) {
    const out = {};
    const named = String(headers.connection || '')
        .split(',')
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean);
    for (const [k, v] of Object.entries(headers)) {
        const lk = k.toLowerCase();
        if (HOP.includes(lk) || named.includes(lk)) continue;
        out[k] = v;
    }
    return out;
}

/**
 * A pass-through for the game website's plain-HTTP traffic, which the launcher maps onto
 * 127.0.0.1 with Chromium's host-resolver rules (those work for the page and Flash's HTTP
 * requests, but not for Flash's sockets). Every request goes on to the real host unchanged,
 * with one exception: the response for DungeonBlitz.swf is handed to `patchSwf`, which points
 * the client's login connection at the meter's relay. If patching fails, the original is sent.
 *
 * Only the addresses in `hosts` are passed on; anything else gets 502.
 */
class WebProxy extends EventEmitter {
    /** hosts: [{ host, port }], the web addresses mapped onto this proxy. */
    constructor({ listenPort, hosts, patchSwf }) {
        super();
        this.listenPort = listenPort;
        this.hosts = new Set(hosts.map((h) => String(h.host).toLowerCase() + ':' + (Number(h.port) || 80)));
        this.patchSwf = patchSwf;
        this.agent = new http.Agent({ keepAlive: true, maxSockets: 16 });
        this.server = null;
        this.listening = false;
        this.error = '';
        this.requests = 0;
        this.swf = null; // { at, url, ok, error, bytes, report }
    }

    listen() {
        return new Promise((resolve) => {
            const server = http.createServer((req, res) => this.handle(req, res));
            server.on('upgrade', (req, socket, head) => this.tunnel(req, socket, head));
            server.on('clientError', (_err, socket) => socket.destroy());
            server.keepAliveTimeout = 60000;
            server.once('error', (err) => {
                this.error = String((err && err.code) || (err && err.message) || err);
                resolve(false);
            });
            server.listen(this.listenPort, '127.0.0.1', () => {
                this.server = server;
                this.listening = true;
                resolve(true);
            });
        });
    }

    close() {
        if (this.server) this.server.close();
        this.server = null;
        this.listening = false;
        this.agent.destroy();
    }

    /** The address the browser meant, from the Host header: { host, port, key }. */
    hostOf(req) {
        const m = /^(\[[^\]]+\]|[^:]+)(?::(\d+))?$/.exec(String(req.headers.host || '').trim().toLowerCase());
        const host = m ? m[1] : '';
        const port = m && m[2] ? Number(m[2]) : 80;
        return { host, port, key: host + ':' + port };
    }

    handle(req, res) {
        const { host, port, key } = this.hostOf(req);
        if (!this.hosts.has(key)) {
            res.writeHead(502, { 'content-type': 'text/plain' });
            res.end('Not a game host: ' + host);
            return;
        }
        this.requests += 1;
        const isSwf = req.method === 'GET' && /\/DungeonBlitz\.swf(\?|$)/i.test(req.url);
        const headers = withoutHop(req.headers);
        if (isSwf) {
            // The whole file, uncompressed and never "not modified", so it can be patched.
            for (const k of Object.keys(headers)) {
                if (/^(accept-encoding|if-none-match|if-modified-since|if-range|range)$/i.test(k)) delete headers[k];
            }
        }
        const up = http.request({ host, port, method: req.method, path: req.url, headers, agent: this.agent });
        up.on('response', (ures) => {
            this.emit('request', { host, url: req.url, method: req.method, status: ures.statusCode });
            if (isSwf && ures.statusCode === 200) {
                this.respondPatched(req, res, req.headers.host, ures);
                return;
            }
            res.writeHead(ures.statusCode, ures.statusMessage, withoutHop(ures.headers));
            ures.pipe(res);
            ures.on('error', () => res.destroy());
        });
        up.on('error', (err) => {
            this.emit('request', { host, url: req.url, method: req.method, status: 0, error: err.message });
            if (!res.headersSent) {
                res.writeHead(502, { 'content-type': 'text/plain' });
                res.end('Could not reach ' + host + ': ' + err.message);
            } else {
                res.destroy();
            }
        });
        req.on('aborted', () => up.destroy());
        req.pipe(up);
    }

    respondPatched(req, res, host, ures) {
        const parts = [];
        ures.on('data', (d) => parts.push(d));
        ures.on('error', () => res.destroy());
        ures.on('end', async () => {
            const original = Buffer.concat(parts);
            let body = original;
            const info = { at: Date.now(), url: 'http://' + host + req.url, ok: false, error: '', bytes: original.length, report: null };
            try {
                const r = await this.patchSwf(original, info.url);
                info.report = r.report;
                if (r.report && r.report.ok) {
                    body = r.swf;
                    info.ok = true;
                } else {
                    info.error = 'the login address was not found in DungeonBlitz.swf';
                }
            } catch (err) {
                info.error = String((err && err.message) || err);
            }
            this.swf = info;
            this.emit('swf', info);
            const headers = withoutHop(ures.headers);
            for (const k of Object.keys(headers)) {
                if (/^(content-length|content-encoding|etag|last-modified|cache-control|expires|surrogate-control)$/i.test(k)) delete headers[k];
            }
            headers['content-length'] = String(body.length);
            // A patched copy names this launcher run's relay port, so it is never cached.
            headers['cache-control'] = 'no-store';
            res.writeHead(200, ures.statusMessage, headers);
            res.end(body);
        });
    }

    /** WebSocket and other upgrades: passed through as raw bytes. */
    tunnel(req, socket, head) {
        const { host, port, key } = this.hostOf(req);
        if (!this.hosts.has(key)) {
            socket.destroy();
            return;
        }
        const up = net.connect(port, host, () => {
            const lines = [req.method + ' ' + req.url + ' HTTP/' + req.httpVersion];
            for (let i = 0; i < req.rawHeaders.length; i += 2) lines.push(req.rawHeaders[i] + ': ' + req.rawHeaders[i + 1]);
            up.write(lines.join('\r\n') + '\r\n\r\n');
            if (head && head.length) up.write(head);
            up.pipe(socket);
            socket.pipe(up);
        });
        const done = () => {
            up.destroy();
            socket.destroy();
        };
        up.on('error', done);
        socket.on('error', done);
        up.on('close', done);
        socket.on('close', done);
    }

    status() {
        return { listenPort: this.listenPort, listening: this.listening, error: this.error, requests: this.requests, swf: this.swf };
    }
}

module.exports = { WebProxy, withoutHop };
