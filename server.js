'use strict';
/*
 * 网页快传 · 信令服务器
 * - 提供静态网页（public/）
 * - WebSocket /ws：按"出口公网 IP"把同一局域网的浏览器分到一组，互相可见；也支持配对码房间
 * - 转发 WebRTC 信令；点对点连不上时，按需中转文件数据（可用 RELAY=0 关闭）
 * 文件内容默认走浏览器之间的 WebRTC 直连，不经过服务器、不落盘。
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const PUBLIC = path.join(__dirname, 'public');
const RELAY = process.env.RELAY !== '0';
const DEFAULT_ICE = [
  { urls: 'stun:stun.miwifi.com:3478' },
  { urls: 'stun:stun.cloudflare.com:3478' },
  { urls: 'stun:stun.l.google.com:19302' },
];
let ICE_SERVERS = DEFAULT_ICE;
if (process.env.ICE_SERVERS) {
  try { ICE_SERVERS = JSON.parse(process.env.ICE_SERVERS); } catch (e) { console.warn('ICE_SERVERS 不是合法 JSON，已使用默认值'); }
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
};

// ---------- 静态文件 ----------
const server = http.createServer((req, res) => {
  let pathname;
  try { pathname = decodeURIComponent(new URL(req.url, 'http://x').pathname); } catch { pathname = '/'; }
  if (pathname === '/healthz') { res.writeHead(200, { 'Content-Type': 'text/plain' }); res.end('ok'); return; }
  if (pathname.endsWith('/')) pathname += 'index.html';
  const file = path.join(PUBLIC, path.normalize(pathname));
  if (!file.startsWith(PUBLIC + path.sep)) { res.writeHead(403); res.end(); return; }
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('Not found'); return; }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Content-Length': st.size,
      'Cache-Control': 'no-cache',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
    });
    if (req.method === 'HEAD') { res.end(); return; }
    fs.createReadStream(file).pipe(res);
  });
});

// ---------- 分组 ----------
function clientIp(req) {
  const h = req.headers;
  const ip = h['x-real-ip'] || h['cf-connecting-ip'] ||(h['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || '';
  return ip.replace(/^::ffff:/i, '');
}

function expandV6(ip) {
  ip = ip.split('%')[0];
  const [head, tail] = ip.split('::');
  const a = head ? head.split(':') : [];
  const b = tail !== undefined ? (tail ? tail.split(':') : []) : [];
  const fill = tail !== undefined ? new Array(8 - a.length - b.length).fill('0') : [];
  return [...a, ...fill, ...b].map((x) => x.padStart(4, '0').toLowerCase());
}

function isPrivate(ip) {
  if (ip.includes(':')) {
    const p = expandV6(ip);
    const first = parseInt(p[0], 16);
    return p.join(':') === '0000:0000:0000:0000:0000:0000:0000:0001' || (first & 0xfe00) === 0xfc00 || (first & 0xffc0) === 0xfe80;
  }
  const [a, b] = ip.split('.').map(Number);
  return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254);
}

// 同一出口 IP（IPv6 取 /64 网段）视为同一局域网；服务器就部署在局域网里时，所有内网地址归为一组
function networkKey(ip) {
  if (!ip || isPrivate(ip)) return 'net:lan';
  if (ip.includes(':')) return 'net:' + expandV6(ip).slice(0, 4).join(':');
  return 'net:' + ip;
}

const peers = new Map(); // id -> peer
const groups = new Map(); // groupKey -> Set<id>

function addTo(key, peer) {
  if (!groups.has(key)) groups.set(key, new Set());
  groups.get(key).add(peer.id);
  peer.groups.add(key);
}
function removeFrom(key, peer) {
  const g = groups.get(key);
  if (g) { g.delete(peer.id); if (!g.size) groups.delete(key); }
  peer.groups.delete(key);
}
function members(keys) {
  const ids = new Set();
  for (const k of keys) for (const id of groups.get(k) || []) ids.add(id);
  return ids;
}
function shared(a, b) {
  const via = [];
  for (const k of a.groups) if (b.groups.has(k)) via.push(k.startsWith('room:') ? 'room' : 'lan');
  return via;
}
function send(peer, msg) {
  if (peer.ws.readyState === 1) peer.ws.send(JSON.stringify(msg));
}
function pushPeers(peer) {
  const list = [];
  for (const id of members(peer.groups)) {
    if (id === peer.id) continue;
    const p = peers.get(id);
    if (p && p.joined) list.push({ id: p.id, name: p.name, device: p.device, key: p.key, via: shared(peer, p) });
  }
  send(peer, { type: 'peers', peers: list });
}
function refresh(ids) {
  for (const id of ids) { const p = peers.get(id); if (p && p.joined) pushPeers(p); }
}

const str = (v, n) => (typeof v === 'string' ? v.trim().slice(0, n) : '');
const roomCode = (v) => { const r = str(v, 16).toUpperCase(); return /^[A-Z0-9]{4,16}$/.test(r) ? r : ''; };

// ---------- WebSocket ----------
const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 1 << 20 });

wss.on('connection', (ws, req) => {
  const peer = {
    id: crypto.randomBytes(6).toString('hex'),
    ws,
    net: networkKey(clientIp(req)),
    groups: new Set(),
    joined: false,
    name: '',
    device: {},
    key: '',
    room: '',
  };
  peers.set(peer.id, peer);
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', (data, isBinary) => {
    if (isBinary) return relayBinary(peer, data);
    let m;
    try { m = JSON.parse(data.toString()); } catch { return; }
    if (!m || typeof m !== 'object') return;
    switch (m.type) {
      case 'join': {
        if (peer.joined) return;
        peer.name = str(m.name, 32) || '匿名设备';
        peer.key = str(m.key, 64);
        const d = m.device || {};
        peer.device = { os: str(d.os, 20), browser: str(d.browser, 20), type: str(d.type, 10) };
        peer.joined = true;
        addTo(peer.net, peer);
        peer.room = roomCode(m.room);
        if (peer.room) addTo('room:' + peer.room, peer);
        send(peer, { type: 'welcome', id: peer.id, iceServers: ICE_SERVERS, relay: RELAY, lan: peer.net === 'net:lan' });
        refresh(members(peer.groups));
        break;
      }
      case 'rename': {
        peer.name = str(m.name, 32) || peer.name;
        refresh(members(peer.groups));
        break;
      }
      case 'room': {
        const affected = members(peer.groups);
        if (peer.room) removeFrom('room:' + peer.room, peer);
        peer.room = roomCode(m.room);
        if (peer.room) addTo('room:' + peer.room, peer);
        for (const id of members(peer.groups)) affected.add(id);
        affected.add(peer.id);
        refresh(affected);
        break;
      }
      case 'signal':
      case 'relay': {
        if (m.type === 'relay' && !RELAY) return;
        const target = peers.get(m.to);
        if (!target || target === peer || !shared(peer, target).length) return;
        send(target, { type: m.type, from: peer.id, data: m.data });
        break;
      }
      case 'ping':
        send(peer, { type: 'pong' });
        break;
    }
  });

  ws.on('close', () => {
    const affected = members(peer.groups);
    for (const k of [...peer.groups]) removeFrom(k, peer);
    peers.delete(peer.id);
    affected.delete(peer.id);
    refresh(affected);
  });
  ws.on('error', () => {});
});

// 中转的二进制帧：[1 字节 id 长度][目标 id][数据] → 转发为 [1 字节 id 长度][来源 id][数据]
function relayBinary(peer, buf) {
  if (!RELAY || !peer.joined || buf.length < 2) return;
  const n = buf[0];
  const to = buf.toString('utf8', 1, 1 + n);
  const target = peers.get(to);
  if (!target || target === peer || !shared(peer, target).length || target.ws.readyState !== 1) return;
  const from = Buffer.from(peer.id);
  const out = Buffer.allocUnsafe(1 + from.length + buf.length - 1 - n);
  out[0] = from.length;
  from.copy(out, 1);
  buf.copy(out, 1 + from.length, 1 + n);
  target.ws.send(out, { binary: true });
}

const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) { ws.terminate(); continue; }
    ws.isAlive = false;
    try { ws.ping(); } catch {}
  }
}, 30000);
wss.on('close', () => clearInterval(heartbeat));

server.listen(PORT, HOST, () => {
  console.log(`网页快传已启动：http://localhost:${PORT}`);
  const nets = require('os').networkInterfaces();
  for (const list of Object.values(nets)) {
    for (const n of list || []) if (n.family === 'IPv4' && !n.internal) console.log(`  局域网访问：http://${n.address}:${PORT}`);
  }
});
