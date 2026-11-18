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
// 掉线后保留身份的时间：手机切到别的 App、网络抖动、换 Wi-Fi/流量，在这段时间内回来都能接着传
const GRACE = Number(process.env.GRACE_MS) || 90000;
const DEFAULT_ICE = [
  { urls: 'stun:stun.miwifi.com:3478' },
  { urls: 'stun:stun.chat.bilibili.com:3478' },
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
  if (pathname === '/index.html') return sendIndex(req, res);
  const file = path.join(PUBLIC, path.normalize(pathname));
  if (!file.startsWith(PUBLIC + path.sep)) { res.writeHead(403); res.end(); return; }
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('Not found'); return; }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Content-Length': st.size,
      'Cache-Control': /[?&]v=/.test(req.url) ? 'public, max-age=31536000, immutable' : 'no-cache',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
    });
    if (req.method === 'HEAD') { res.end(); return; }
    fs.createReadStream(file).pipe(res);
  });
});

// 首页里的脚本和样式地址带上版本号（文件修改时间）。CDN（如 Cloudflare）会无视 no-cache 把 .js/.css 缓存几个小时，
// 不带版本号的话，更新部署后用户拿到的还是旧脚本；首页本身不缓存，所以新地址总能立刻生效。
const ASSETS = ['tokens.css', 'style.css', 'app.js'];
function sendIndex(req, res) {
  let html;
  try {
    html = fs.readFileSync(path.join(PUBLIC, 'index.html'), 'utf8');
    for (const a of ASSETS) {
      const v = Math.floor(fs.statSync(path.join(PUBLIC, a)).mtimeMs).toString(36);
      html = html.replace(`"${a}"`, `"${a}?v=${v}"`);
    }
  } catch { res.writeHead(500); res.end(); return; }
  const body = Buffer.from(html);
  res.writeHead(200, {
    'Content-Type': MIME['.html'],
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
  });
  res.end(req.method === 'HEAD' ? undefined : body);
}

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
  if (peer.ws && peer.ws.readyState === 1) peer.ws.send(JSON.stringify(msg));
}
function pushPeers(peer) {
  const list = [];
  for (const id of members(peer.groups)) {
    if (id === peer.id) continue;
    const p = peers.get(id);
    if (p && p.joined) list.push({ id: p.id, name: p.name, device: p.device, key: p.key, via: shared(peer, p), away: p.away });
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
const log = (...a) => console.log(a.join(' '));
const secs = (t) => Math.round((Date.now() - t) / 1000) + 's';

// 加入或恢复：断线后在 GRACE 时间内带着 id + token 回来，身份不变，对方的传输和直连都不受影响
function join(ws, ip, m) {
  const net = networkKey(ip);
  const r = m.resume && typeof m.resume === 'object' ? m.resume : null;
  let peer = r ? peers.get(str(r.id, 24)) : null;
  const resumed = !!(peer && peer.token === r.token);
  const affected = new Set();
  if (resumed) {
    clearTimeout(peer.timer);
    for (const id of members(peer.groups)) affected.add(id);
    const old = peer.ws;
    peer.ws = ws;
    if (old) try { old.terminate(); } catch {}
    if (peer.net !== net) { removeFrom(peer.net, peer); peer.net = net; addTo(net, peer); }
    log('resume', peer.id, ip, peer.away ? '离线' + secs(peer.awaySince) : '顶替旧连接', '第' + ++peer.resumes + '次');
    peer.away = false;
  } else {
    peer = {
      id: crypto.randomBytes(6).toString('hex'), token: crypto.randomBytes(12).toString('hex'),
      ws, net, groups: new Set(), joined: true, away: false, awaySince: 0, timer: null,
      name: '', device: {}, key: '', room: '', since: Date.now(), resumes: 0, relayed: 0,
    };
    peers.set(peer.id, peer);
    addTo(net, peer);
    // 同一浏览器刷新页面后以新身份加入：它之前那个掉线中的身份不会再回来了，立刻清掉，免得对方看到一张灰色的旧卡片
    const key = str(m.key, 64);
    if (key) for (const p of [...peers.values()]) if (p !== peer && p.away && p.key === key) drop(p, '同一设备已重新加入');
  }
  peer.name = str(m.name, 32) || peer.name || '匿名设备';
  peer.key = str(m.key, 64);
  const d = m.device || {};
  peer.device = { os: str(d.os, 20), browser: str(d.browser, 20), type: str(d.type, 10) };
  const room = roomCode(m.room);
  if (room !== peer.room) {
    if (peer.room) removeFrom('room:' + peer.room, peer);
    peer.room = room;
    if (room) addTo('room:' + room, peer);
  }
  if (!resumed) log('join', peer.id, ip, `${peer.device.os}/${peer.device.browser}`, room ? '有配对码' : '无配对码', JSON.stringify(peer.name));
  send(peer, { type: 'welcome', id: peer.id, token: peer.token, resumed, iceServers: ICE_SERVERS, relay: RELAY, lan: peer.net === 'net:lan' });
  for (const id of members(peer.groups)) affected.add(id);
  refresh(affected);
  return peer;
}
function drop(peer, why) {
  clearTimeout(peer.timer);
  if (!peers.has(peer.id)) return;
  const affected = members(peer.groups);
  for (const k of [...peer.groups]) removeFrom(k, peer);
  peers.delete(peer.id);
  affected.delete(peer.id);
  log('leave', peer.id, why, '在线' + secs(peer.since), '重连' + peer.resumes + '次', '中转' + (peer.relayed / 1048576).toFixed(1) + 'MB');
  refresh(affected);
}

wss.on('connection', (ws, req) => {
  const ip = clientIp(req);
  let peer = null;
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', (data, isBinary) => {
    ws.isAlive = true;
    if (peer && peer.ws !== ws) return; // 已被新连接顶替
    if (isBinary) { if (peer) relayBinary(peer, data); return; }
    let m;
    try { m = JSON.parse(data.toString()); } catch { return; }
    if (!m || typeof m !== 'object') return;
    if (m.type === 'ping') { if (ws.readyState === 1) ws.send('{"type":"pong"}'); return; }
    if (m.type === 'join') { if (!peer) peer = join(ws, ip, m); return; }
    if (!peer) return;
    switch (m.type) {
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
      case 'diag': { // 浏览器上报的直连结果，只写日志，方便排查“为什么只能中转”
        let d = '';
        try { d = JSON.stringify(m.d).slice(0, 400); } catch {}
        log('diag', peer.id, '→', str(m.to, 24), str(m.ev, 20), d);
        break;
      }
      case 'leave': // 页面关闭：不用等宽限期
        drop(peer, '关闭页面');
        try { ws.close(); } catch {}
        break;
    }
  });

  ws.on('close', (code) => {
    if (!peer || peer.ws !== ws || !peers.has(peer.id)) return;
    peer.ws = null;
    peer.away = true;
    peer.awaySince = Date.now();
    peer.timer = setTimeout(() => drop(peer, '掉线超时'), GRACE);
    log('away', peer.id, 'code=' + code);
    refresh(members(peer.groups));
  });
  ws.on('error', () => {});
});

// 中转的二进制帧：[1 字节 id 长度][目标 id][数据] → 转发为 [1 字节 id 长度][来源 id][数据]
function relayBinary(peer, buf) {
  if (!RELAY || !peer.joined || buf.length < 2) return;
  const n = buf[0];
  const to = buf.toString('utf8', 1, 1 + n);
  const target = peers.get(to);
  if (!target || target === peer || !shared(peer, target).length || !target.ws || target.ws.readyState !== 1) return;
  peer.relayed += buf.length;
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
