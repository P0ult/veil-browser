'use strict';
const net = require('node:net');

/**
 * A local SOCKS5 front door for an authenticated upstream proxy.
 *
 * Chromium speaks SOCKS5, but it has never supported username/password
 * authentication on it - and almost every commercial VPN's SOCKS5 endpoint
 * requires exactly that. So Veil listens on loopback without authentication,
 * and forwards each connection upstream with the credentials attached.
 *
 * Only the loopback interface is bound, so nothing outside this machine can
 * reach it, and hostnames are passed through untouched so DNS is still
 * resolved at the far end rather than here.
 */

const VER = 0x05;
const NO_AUTH = 0x00;
const USER_PASS = 0x02;
const CMD_CONNECT = 0x01;

const ATYP = { IPV4: 0x01, DOMAIN: 0x03, IPV6: 0x04 };

const REPLY = {
  OK: 0x00,
  GENERAL: 0x01,
  NOT_ALLOWED: 0x02,
  NET_UNREACHABLE: 0x03,
  HOST_UNREACHABLE: 0x04,
  REFUSED: 0x05,
  CMD_UNSUPPORTED: 0x07
};

/** Reads exactly n bytes from a socket, buffering whatever arrives. */
function read(socket, n) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let have = 0;

    const onData = (chunk) => {
      chunks.push(chunk);
      have += chunk.length;
      if (have < n) return;
      cleanup();
      const all = Buffer.concat(chunks);
      if (all.length > n) socket.unshift(all.subarray(n));
      resolve(all.subarray(0, n));
    };
    const onEnd = () => { cleanup(); reject(new Error('connection closed early')); };
    const onErr = (e) => { cleanup(); reject(e); };
    function cleanup() {
      socket.removeListener('data', onData);
      socket.removeListener('end', onEnd);
      socket.removeListener('error', onErr);
      socket.pause();
    }

    socket.on('data', onData);
    socket.once('end', onEnd);
    socket.once('error', onErr);
    socket.resume();
  });
}

/** Reads a SOCKS5 address field and returns it plus the bytes it occupied. */
async function readAddress(socket, atyp) {
  if (atyp === ATYP.IPV4) {
    const b = await read(socket, 4);
    return { host: b.join('.'), raw: b };
  }
  if (atyp === ATYP.IPV6) {
    const b = await read(socket, 16);
    const parts = [];
    for (let i = 0; i < 16; i += 2) parts.push(b.readUInt16BE(i).toString(16));
    return { host: parts.join(':'), raw: b };
  }
  if (atyp === ATYP.DOMAIN) {
    const len = (await read(socket, 1))[0];
    const b = await read(socket, len);
    return { host: b.toString('utf8'), raw: Buffer.concat([Buffer.from([len]), b]) };
  }
  throw new Error('unsupported address type');
}

function reply(socket, code) {
  // BND.ADDR/BND.PORT are not meaningful for a CONNECT relay; zeros are fine.
  socket.write(Buffer.from([VER, code, 0x00, ATYP.IPV4, 0, 0, 0, 0, 0, 0]));
}

class SocksRelay {
  /**
   * @param {object} opts { host, port, username, password }
   */
  constructor(opts) {
    this.upstream = opts;
    this.server = null;
    this.port = 0;
    this.sockets = new Set();
  }

  listen() {
    return new Promise((resolve, reject) => {
      this.server = net.createServer((socket) => this.handle(socket));
      this.server.on('error', reject);
      this.server.listen(0, '127.0.0.1', () => {
        this.port = this.server.address().port;
        resolve(this.port);
      });
    });
  }

  close() {
    for (const s of this.sockets) { try { s.destroy(); } catch {} }
    this.sockets.clear();
    if (this.server) { try { this.server.close(); } catch {} this.server = null; }
    this.port = 0;
  }

  track(socket) {
    this.sockets.add(socket);
    socket.once('close', () => this.sockets.delete(socket));
    socket.on('error', () => { try { socket.destroy(); } catch {} });
  }

  async handle(client) {
    this.track(client);
    client.setNoDelay(true);

    let upstream = null;
    try {
      // --- greeting from Chromium: it offers no-auth ---
      const head = await read(client, 2);
      if (head[0] !== VER) throw new Error('not socks5');
      await read(client, head[1]);                 // discard the method list
      client.write(Buffer.from([VER, NO_AUTH]));

      // --- the request ---
      const req = await read(client, 4);
      if (req[0] !== VER) throw new Error('bad request');
      if (req[1] !== CMD_CONNECT) {
        reply(client, REPLY.CMD_UNSUPPORTED);
        return client.end();
      }
      const addr = await readAddress(client, req[3]);
      const portBuf = await read(client, 2);

      upstream = await this.openUpstream(req[3], addr, portBuf);
      this.track(upstream);

      reply(client, REPLY.OK);
      client.pipe(upstream);
      upstream.pipe(client);

      const drop = () => { try { client.destroy(); } catch {} try { upstream.destroy(); } catch {} };
      client.once('close', drop);
      upstream.once('close', drop);
    } catch (e) {
      if (upstream) { try { upstream.destroy(); } catch {} }
      try { reply(client, REPLY.HOST_UNREACHABLE); } catch {}
      try { client.end(); } catch {}
    }
  }

  /** Open the far side, authenticate, and ask it for the same destination. */
  openUpstream(atyp, addr, portBuf) {
    const { host, port, username, password } = this.upstream;

    return new Promise((resolve, reject) => {
      const sock = net.connect({ host, port }, async () => {
        try {
          sock.setNoDelay(true);

          const methods = username ? [NO_AUTH, USER_PASS] : [NO_AUTH];
          sock.write(Buffer.from([VER, methods.length, ...methods]));

          const chosen = await read(sock, 2);
          if (chosen[0] !== VER) throw new Error('upstream is not socks5');

          if (chosen[1] === USER_PASS) {
            if (!username) throw new Error('upstream wants credentials');
            const u = Buffer.from(username, 'utf8');
            const p = Buffer.from(password || '', 'utf8');
            sock.write(Buffer.concat([
              Buffer.from([0x01, u.length]), u,
              Buffer.from([p.length]), p
            ]));
            const auth = await read(sock, 2);
            if (auth[1] !== 0x00) throw new Error('proxy rejected the credentials');
          } else if (chosen[1] !== NO_AUTH) {
            throw new Error('no acceptable authentication method');
          }

          sock.write(Buffer.concat([
            Buffer.from([VER, CMD_CONNECT, 0x00, atyp]), addr.raw, portBuf
          ]));

          const res = await read(sock, 4);
          if (res[1] !== REPLY.OK) throw new Error('upstream refused (code ' + res[1] + ')');
          await readAddress(sock, res[3]);          // consume BND.ADDR
          await read(sock, 2);                      // consume BND.PORT

          resolve(sock);
        } catch (e) {
          try { sock.destroy(); } catch {}
          reject(e);
        }
      });
      sock.once('error', reject);
      sock.setTimeout(20000, () => {
        sock.destroy();
        reject(new Error('upstream timed out'));
      });
    });
  }
}

module.exports = { SocksRelay };
