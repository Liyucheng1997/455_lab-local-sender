'use strict';
/* 网页快传 · 前端
 * 发现：连上服务器后，服务器按出口 IP 把同一网络的设备推送过来
 * 传输：优先 WebRTC DataChannel 点对点直连；连不上时经服务器 WebSocket 中转
 * 协议（JSON 控制消息 + 二进制数据块）：
 *   req{tid,files:[{name,size,type}|{path,size}],total} → acc/rej → [fh{i} 数据块... fe{i}]×N → done；接收方每 1MB 回 ack；任一方可 cancel
 *   text{text}
 * 文件夹：files 里带相对路径 path，接收方收完后打包成一个 ZIP 下载
 */

// ---------- 常量与工具 ----------
const CHUNK = 64 * 1024;
const READ_BLOCK = 2 * 1024 * 1024;
const ACK_EVERY = 256 * 1024;
const P2P_WAIT = 6000; // 发送前最多等直连这么久
const P2P_GIVEUP = 15000; // 一次直连尝试的期限，超过就记为失败、稍后重试
const MAX_FILES = 5000; // 一次最多发送的文件数
const MAX_REQ = 250000; // 文件清单最大字节数（Chrome 直连单条消息上限 256KB）
const JUNK = /^(\.DS_Store|Thumbs\.db|desktop\.ini)$/i; // 文件夹里的系统垃圾文件，不发

const $ = (s, el = document) => el.querySelector(s);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rid = (n = 8) => Array.from(crypto.getRandomValues(new Uint8Array(n)), (b) => b.toString(16).padStart(2, '0')).join('');
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const store = {
  get(k, d) { try { const v = localStorage.getItem('ls.' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('ls.' + k, JSON.stringify(v)); } catch {} },
};
function fmtSize(n) {
  if (n < 1024) return n + ' B';
  const u = ['KB', 'MB', 'GB', 'TB'];
  let i = -1;
  do { n /= 1024; i++; } while (n >= 1024 && i < u.length - 1);
  return (n >= 100 ? n.toFixed(0) : n >= 10 ? n.toFixed(1) : n.toFixed(2)) + ' ' + u[i];
}
const fmtTime = (d = new Date()) => d.toTimeString().slice(0, 5);

// ---------- 文件夹 ----------
// 文件在文件夹里的相对路径（拖进来的文件夹 / 选择文件夹），普通文件为空
const relPath = (f) => f.relPath || f.webkitRelativePath || '';
const fileMeta = (f) => {
  const p = relPath(f);
  return p.includes('/') ? { path: p, size: f.size } : { name: f.name, size: f.size, type: f.type };
};
const safeName = (s) => String(s || '').replace(/[\x00-\x1f\\/:*?"<>|]/g, '_').trim().slice(0, 200) || 'file';
function safePath(p, fallback) {
  const segs = String(p || '').split(/[\\/]+/).map((s) => s.replace(/[\x00-\x1f:*?"<>|]/g, '_').trim().slice(0, 120)).filter((s) => s && s !== '.' && s !== '..');
  return segs.join('/').slice(0, 1000) || fallback;
}
// 这批里有文件夹时返回打包名：只有一个顶层文件夹就用它的名字，否则用时间
function bundleName(paths) {
  if (!paths.some((p) => p.includes('/'))) return '';
  const tops = new Set(paths.map((p) => (p.includes('/') ? p.split('/')[0] : '')));
  if (tops.size === 1 && !tops.has('')) return [...tops][0];
  const d = new Date();
  return `快传文件-${d.getMonth() + 1}月${d.getDate()}日${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}`;
}
// 手机浏览器基本不支持选文件夹，只在电脑上显示“文件夹”按钮
const canPickDir = !/Android|iPhone|iPad|iPod/.test(navigator.userAgent) && !(/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1)
  && 'webkitdirectory' in document.createElement('input');

const CRC_T = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c; }
  return t;
})();
function crc32(u8, crc = 0) {
  crc = ~crc;
  for (let i = 0; i < u8.length; i++) crc = CRC_T[(crc ^ u8[i]) & 255] ^ (crc >>> 8);
  return ~crc >>> 0;
}
// 打包成 ZIP：只存储不压缩，数据直接引用已收到的 Blob、不额外复制；单个文件或总量超过 4GB 时用 ZIP64
function makeZip(entries) {
  const enc = new TextEncoder();
  const u64 = (dv, o, v) => { dv.setUint32(o, v % 4294967296, true); dv.setUint32(o + 4, Math.floor(v / 4294967296), true); };
  const BIG = 0xffffffff;
  const d = new Date();
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
  const date = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  const parts = [], cds = [];
  let off = 0;
  for (const e of entries) {
    const name = enc.encode(e.path), size = e.blob.size, z = size >= BIG;
    // 本地文件头
    const lh = new DataView(new ArrayBuffer(30 + name.length + (z ? 20 : 0)));
    lh.setUint32(0, 0x04034b50, true);
    lh.setUint16(4, z ? 45 : 20, true);
    lh.setUint16(6, 0x0800, true); // 文件名是 UTF-8
    lh.setUint16(10, time, true);
    lh.setUint16(12, date, true);
    lh.setUint32(14, e.crc, true);
    lh.setUint32(18, z ? BIG : size, true);
    lh.setUint32(22, z ? BIG : size, true);
    lh.setUint16(26, name.length, true);
    lh.setUint16(28, z ? 20 : 0, true);
    new Uint8Array(lh.buffer).set(name, 30);
    if (z) { const o = 30 + name.length; lh.setUint16(o, 1, true); lh.setUint16(o + 2, 16, true); u64(lh, o + 4, size); u64(lh, o + 12, size); }
    parts.push(lh.buffer, e.blob);
    // 中央目录项
    const cz = z || off >= BIG;
    const ch = new DataView(new ArrayBuffer(46 + name.length + (cz ? 28 : 0)));
    ch.setUint32(0, 0x02014b50, true);
    ch.setUint16(4, 45, true);
    ch.setUint16(6, cz ? 45 : 20, true);
    ch.setUint16(8, 0x0800, true);
    ch.setUint16(12, time, true);
    ch.setUint16(14, date, true);
    ch.setUint32(16, e.crc, true);
    ch.setUint32(20, cz ? BIG : size, true);
    ch.setUint32(24, cz ? BIG : size, true);
    ch.setUint16(28, name.length, true);
    ch.setUint16(30, cz ? 28 : 0, true);
    ch.setUint32(42, cz ? BIG : off, true);
    new Uint8Array(ch.buffer).set(name, 46);
    if (cz) { const o = 46 + name.length; ch.setUint16(o, 1, true); ch.setUint16(o + 2, 24, true); u64(ch, o + 4, size); u64(ch, o + 12, size); u64(ch, o + 20, off); }
    cds.push(ch.buffer);
    off += lh.byteLength + size;
  }
  const cdOff = off, cdSize = cds.reduce((s, b) => s + b.byteLength, 0), n = entries.length;
  parts.push(...cds);
  if (n >= 0xffff || cdOff >= BIG || cdSize >= BIG) {
    // ZIP64 目录结束记录 + 定位器
    const z = new DataView(new ArrayBuffer(76));
    z.setUint32(0, 0x06064b50, true);
    u64(z, 4, 44);
    z.setUint16(12, 45, true);
    z.setUint16(14, 45, true);
    u64(z, 24, n);
    u64(z, 32, n);
    u64(z, 40, cdSize);
    u64(z, 48, cdOff);
    z.setUint32(56, 0x07064b50, true);
    u64(z, 64, cdOff + cdSize);
    z.setUint32(72, 1, true);
    parts.push(z.buffer);
  }
  const eo = new DataView(new ArrayBuffer(22));
  eo.setUint32(0, 0x06054b50, true);
  eo.setUint16(8, Math.min(n, 0xffff), true);
  eo.setUint16(10, Math.min(n, 0xffff), true);
  eo.setUint32(12, Math.min(cdSize, BIG), true);
  eo.setUint32(16, Math.min(cdOff, BIG), true);
  parts.push(eo.buffer);
  return new Blob(parts, { type: 'application/zip' });
}

// ---------- 图标（lucide 风格） ----------
const P = {
  monitor: '<rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4"/>',
  phone: '<rect x="6" y="2" width="12" height="20" rx="2.5"/><path d="M11 18h2"/>',
  tablet: '<rect x="4" y="2" width="16" height="20" rx="2.5"/><path d="M11 18h2"/>',
  folder: '<path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.7-.9l-.8-1.2A2 2 0 0 0 7.9 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2z"/>',
  file: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/>',
  text: '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>',
  upload: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m17 8-5-5-5 5M12 3v12"/>',
  moon: '<path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9z"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
  link: '<path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7"/><path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7"/>',
  copy: '<rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
  x: '<path d="M18 6 6 18M6 6l12 12"/>',
};
const icon = (name, size = 18, sw = 1.9) => `<svg class="ico" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round">${P[name]}</svg>`;

// ---------- 身份 ----------
const ADJ = ['灵动的', '安静的', '勇敢的', '温柔的', '机智的', '快乐的', '闪亮的', '悠闲的', '好奇的', '认真的', '活泼的', '可爱的', '酷酷的', '飞快的'];
const ANI = ['熊猫', '海豚', '狐狸', '企鹅', '考拉', '松鼠', '白鲸', '猫头鹰', '柴犬', '水獭', '小鹿', '兔子', '刺猬', '海獭', '橘猫'];
const pick = (a) => a[Math.floor(Math.random() * a.length)];

function detectDevice() {
  const ua = navigator.userAgent;
  let os = '设备', type = 'desktop', browser = '';
  if (/iPad/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)) { os = 'iPad'; type = 'tablet'; }
  else if (/iPhone|iPod/.test(ua)) { os = 'iPhone'; type = 'phone'; }
  else if (/Android/.test(ua)) { os = 'Android'; type = /Mobile/.test(ua) ? 'phone' : 'tablet'; }
  else if (/Windows/.test(ua)) os = 'Windows';
  else if (/Mac OS X/.test(ua)) os = 'macOS';
  else if (/CrOS/.test(ua)) os = 'ChromeOS';
  else if (/Linux/.test(ua)) os = 'Linux';
  if (/MicroMessenger/.test(ua)) browser = '微信';
  else if (/Edg\//.test(ua)) browser = 'Edge';
  else if (/OPR\//.test(ua)) browser = 'Opera';
  else if (/Firefox\//.test(ua)) browser = 'Firefox';
  else if (/Chrome\//.test(ua)) browser = 'Chrome';
  else if (/Safari\//.test(ua)) browser = 'Safari';
  return { os, browser, type };
}

const me = {
  id: null,
  key: store.get('key') || (() => { const k = rid(12); store.set('key', k); return k; })(),
  name: store.get('name') || (() => { const n = pick(ADJ) + pick(ANI); store.set('name', n); return n; })(),
  device: detectDevice(),
  room: store.get('room', ''),
};
const devIcon = (d) => (d && d.type === 'phone' ? 'phone' : d && d.type === 'tablet' ? 'tablet' : 'monitor');
const devText = (d) => [d && d.os, d && d.browser].filter(Boolean).join(' · ') || '未知设备';

// ---------- 服务器连接 ----------
// 与服务器的连接随时可能断（跨境线路、手机切到后台、换网络）。断了就立刻重连，并带上原来的 id + token，
// 服务器会把我们认回同一台设备：对方看到的还是同一张卡片，正在传的文件接着传，已建好的直连不受影响。
let ws = null;
let wsRetry = 0;
let wsTimer = null;
let lastRx = 0;
let pingAt = 0;
let justJoined = false;
let iceServers = [{ urls: 'stun:stun.miwifi.com:3478' }, { urls: 'stun:stun.l.google.com:19302' }];
let relayAllowed = true;
const peers = new Map();

const wsUp = () => !!ws && !ws.dead && ws.readyState === 1;
function wsSend(obj) {
  if (wsUp()) { ws.send(JSON.stringify(obj)); return true; }
  return false;
}
function signal(to, data) { wsSend({ type: 'signal', to, data }); }
// 链路类错误：传输中遇到它不算失败，等链路恢复后续传
function linkErr(msg) { const e = new Error(msg); e.link = true; return e; }

function connectServer() {
  clearTimeout(wsTimer);
  if (ws && !ws.dead && ws.readyState <= 1) return;
  setConn('wait');
  const sock = (ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`));
  sock.binaryType = 'arraybuffer';
  sock.onopen = () => {
    lastRx = Date.now();
    sock.send(JSON.stringify({
      type: 'join', key: me.key, name: me.name, device: me.device, room: me.room,
      resume: me.id ? { id: me.id, token: me.token } : undefined,
    }));
  };
  sock.onmessage = (e) => {
    if (sock !== ws) return;
    lastRx = Date.now();
    if (typeof e.data !== 'string') return onRelayBinary(e.data);
    let m;
    try { m = JSON.parse(e.data); } catch { return; }
    if (m.type === 'welcome') {
      // 离线太久、或服务器重启过：身份已失效，之前的设备列表全部作废
      if (me.id && me.id !== m.id) dropPeers('连接已重置');
      me.id = m.id;
      me.token = m.token;
      wsRetry = 0;
      justJoined = true;
      if (Array.isArray(m.iceServers) && m.iceServers.length) iceServers = m.iceServers;
      relayAllowed = m.relay !== false;
      setConn('ok');
    } else if (m.type === 'peers') {
      updatePeers(m.peers || []);
      if (justJoined) { justJoined = false; for (const p of peers.values()) p.recover(); }
    } else if (m.type === 'signal') peers.get(m.from)?.onSignal(m.data || {});
    else if (m.type === 'relay') peers.get(m.from)?.onMsg(m.data || {}, 'relay');
  };
  sock.onclose = () => {
    if (sock.dead) return;
    sock.dead = true;
    if (sock !== ws) return;
    setConn('bad');
    for (const p of peers.values()) p.paint();
    wsTimer = setTimeout(connectServer, wsRetry ? Math.min(600 * 2 ** wsRetry, 5000) : 300);
    wsRetry++;
  };
}
// 连接看着还在、其实已经不通（半开）时，不等系统超时，直接弃掉重连
function kickWs() {
  const s = ws;
  if (!s || s.dead) return;
  try { s.close(); } catch {}
  s.onclose();
}
setInterval(() => {
  if (!wsUp()) return;
  if (pingAt > lastRx && Date.now() - pingAt > 30000) return kickWs();
  if (pingAt <= lastRx) { pingAt = Date.now(); wsSend({ type: 'ping' }); }
}, 15000);
// 回到页面、网络恢复时马上检查一次，而不是等下一轮定时器（后台页面的定时器会被浏览器大幅放慢）
function wakeUp() {
  if (!ws || ws.dead || ws.readyState > 1) { wsRetry = 0; connectServer(); return; }
  if (ws.readyState !== 1) return;
  const at = (pingAt = Date.now());
  wsSend({ type: 'ping' });
  setTimeout(() => { if (lastRx < at && pingAt === at) kickWs(); }, 5000);
}
document.addEventListener('visibilitychange', () => { if (!document.hidden) { wakeUp(); syncWakeLock(); } });
window.addEventListener('online', wakeUp);
window.addEventListener('pageshow', (e) => { if (e.persisted) wakeUp(); });
// 真正关闭/刷新页面时告诉服务器，对方那边立刻消失，不用等掉线宽限期
window.addEventListener('pagehide', () => { wsSend({ type: 'leave' }); });

// 中转二进制帧：[1 字节 id 长度][id][数据]
function relaySendBin(to, u8) {
  const id = new TextEncoder().encode(to);
  const out = new Uint8Array(1 + id.length + u8.byteLength);
  out[0] = id.length;
  out.set(id, 1);
  out.set(u8, 1 + id.length);
  ws.send(out);
}
function onRelayBinary(buf) {
  const u8 = new Uint8Array(buf);
  const n = u8[0];
  const from = new TextDecoder().decode(u8.subarray(1, 1 + n));
  peers.get(from)?.onBin(buf.slice(1 + n), 'relay');
}

function updatePeers(list) {
  const seen = new Set();
  for (const info of list) {
    seen.add(info.id);
    const p = peers.get(info.id);
    if (p) p.update(info);
    else peers.set(info.id, new Peer(info));
  }
  for (const [id, p] of peers) if (!seen.has(id)) { p.destroy('对方已离开'); peers.delete(id); }
  renderEmpty();
}
function dropPeers(reason) {
  for (const p of [...peers.values()]) p.destroy(reason);
  peers.clear();
  renderEmpty();
}

// 传输时保持屏幕常亮：手机一锁屏，浏览器就会掐掉网络
let wakeLock = null;
async function syncWakeLock() {
  const need = [...peers.values()].some((p) => p.out || p.inc);
  if (need && !wakeLock && !document.hidden && navigator.wakeLock) {
    try {
      const l = (wakeLock = await navigator.wakeLock.request('screen'));
      l.addEventListener('release', () => { if (wakeLock === l) wakeLock = null; });
    } catch {}
  } else if (!need && wakeLock) {
    const l = wakeLock;
    wakeLock = null;
    l.release().catch(() => {});
  }
}

// 解析 ICE 候选地址，只取类型和地址族，用于判断“为什么连不上”
function candInfo(s) {
  const p = String(s || '').split(' ');
  const k = p.indexOf('typ');
  if (k < 0 || p.length < 8) return null;
  const ip = p[4] || '';
  const fam = ip.endsWith('.local') ? 'm' : ip.includes(':') ? 6 : 4;
  return { type: p[k + 1], fam, port: p[5], kind: p[k + 1] + fam + (p[2].toLowerCase() === 'tcp' ? 't' : '') };
}

// ---------- 对等设备 ----------
class Peer {
  constructor(info) {
    this.info = info;
    this.id = info.id;
    this.pc = null;
    this.dc = null;
    this.pcN = '';
    this.iceQueue = [];
    this.queue = [];
    this.busy = false;
    this.out = null; // 正在发送
    this.inc = null; // 正在接收
    this.waiters = new Map(); // tid -> resolve
    this.openWaiters = [];
    this.doneTids = new Set();
    this.connectStarted = 0;
    this.p2pTries = 0;
    this.p2pTimer = null;
    this.p2pHint = '';
    this.el = this.render();
    this.connectP2P();
  }
  get name() { return this.info.name || '设备'; }
  get away() { return !!this.info.away; }
  get initiator() { return me.id < this.id; }
  get p2p() { return !!this.dc && this.dc.readyState === 'open'; }
  get mode() { return this.p2p ? 'p2p' : 'relay'; }

  update(info) {
    const back = this.info.away && !info.away;
    this.info = info;
    if (back) {
      this.recover();
      if (!this.p2p && Date.now() - this.connectStarted > 8000) { this.p2pTries = 0; this.connectP2P(true); }
    }
    this.paint();
  }

  // --- WebRTC ---
  // id 小的一方发起；另一方只发 want 请求对方发起。每次尝试带一个编号 n，旧尝试迟到的应答/候选一律丢弃。
  connectP2P(restart = false) {
    if (!this.el || typeof RTCPeerConnection === 'undefined') return;
    if (this.pc && !restart) return;
    clearTimeout(this.p2pTimer);
    if (!wsUp() || this.away) { this.p2pTimer = setTimeout(() => this.connectP2P(restart), 5000); return; }
    this.connectStarted = Date.now();
    if (this.initiator) { this.resetPC(); this.makePC(true, rid(4)); }
    else signal(this.id, { want: 1, restart });
    this.p2pTimer = setTimeout(() => this.p2pCheck(), P2P_GIVEUP);
    this.paintSoon();
    setTimeout(() => this.paint(), P2P_WAIT + 100);
  }
  // 一段时间还没连上：记一次失败，之后在后台按 4 秒、20 秒、1 分钟、每 3 分钟 重试；连上后的传输自动改走直连
  p2pCheck() {
    if (!this.el) return;
    if (this.p2p) { this.p2pTries = 0; return; }
    if (this.pc) this.report(this.pc, false);
    const delay = [4000, 20000, 60000][this.p2pTries++] ?? 180000;
    this.p2pTimer = setTimeout(() => { if (!this.p2p) this.connectP2P(true); }, delay);
    this.paint();
  }
  makePC(initiator, n) {
    const pc = (this.pc = new RTCPeerConnection({ iceServers }));
    this.pcN = n;
    this.iceQueue = [];
    pc.st = { loc: new Set(), rem: new Set(), ports: new Set(), reported: false };
    pc.onicecandidate = (e) => {
      if (!e.candidate) return;
      const c = candInfo(e.candidate.candidate);
      if (c) { pc.st.loc.add(c.kind); if (c.type === 'srflx' && c.fam === 4) pc.st.ports.add(c.port); }
      signal(this.id, { ice: e.candidate, n });
    };
    pc.onconnectionstatechange = () => {
      if (this.pc !== pc) return;
      const s = pc.connectionState;
      clearTimeout(pc.dcTimer);
      if (s === 'failed' || s === 'closed') this.p2pDown(pc);
      else if (s === 'disconnected') pc.dcTimer = setTimeout(() => { if (this.pc === pc && pc.connectionState === 'disconnected') this.p2pDown(pc); }, 6000);
      this.paintSoon();
    };
    if (initiator) {
      this.bindDC(pc.createDataChannel('ls', { ordered: true }), pc);
      pc.createOffer()
        .then((o) => pc.setLocalDescription(o))
        .then(() => { if (this.pc === pc) signal(this.id, { sdp: pc.localDescription, n }); })
        .catch((e) => console.warn('offer', e));
    } else {
      pc.ondatachannel = (e) => this.bindDC(e.channel, pc);
    }
    return pc;
  }
  bindDC(dc, pc) {
    dc.binaryType = 'arraybuffer';
    dc.bufferedAmountLowThreshold = 1 << 20;
    dc.onopen = () => {
      if (this.pc !== pc) return;
      this.dc = dc;
      this.p2pTries = 0;
      this.p2pHint = '';
      this.openWaiters.splice(0).forEach((r) => r(true));
      this.report(pc, true);
      if (this.out?.hold) this.askResume();
      if (this.inc?.paused) this.sendRp();
      this.paintSoon();
    };
    dc.onclose = () => { if (this.dc === dc && this.pc === pc) this.p2pDown(pc); this.paintSoon(); };
    dc.onbufferedamountlow = () => this.out?.wake?.();
    dc.onmessage = (e) => {
      if (this.dc !== dc) return;
      if (typeof e.data !== 'string') return this.onBin(e.data, 'p2p');
      let m;
      try { m = JSON.parse(e.data); } catch { return; }
      this.onMsg(m, 'p2p');
    };
    this.dc = dc;
  }
  resetPC() {
    const pc = this.pc;
    this.pc = null;
    this.dc = null;
    if (pc) { clearTimeout(pc.dcTimer); try { pc.close(); } catch {} }
  }
  // 直连断了（或没连上就失败了）：正在传的改走中转续传，并在后台重新尝试直连
  p2pDown(pc) {
    const was = !!this.dc && this.pc === pc && pc.st.reported;
    if (!was) this.report(pc, false);
    this.resetPC();
    this.recover();
    if (was) {
      this.p2pTries = 0;
      clearTimeout(this.p2pTimer);
      this.p2pTimer = setTimeout(() => this.connectP2P(true), 1500);
    }
    this.paint();
  }
  // 把直连结果报给服务器写日志（候选地址类型、NAT 类型、耗时），方便事后排查
  async report(pc, ok) {
    const st = pc.st;
    if (!st || st.reported) return;
    st.reported = true;
    const nat = st.ports.size > 1 ? 'symmetric' : st.ports.size ? 'cone' : 'no-srflx';
    const d = { nat, loc: [...st.loc].sort().join(','), rem: [...st.rem].sort().join(','), ice: pc.iceConnectionState, ms: Date.now() - this.connectStarted, tries: this.p2pTries };
    if (ok) {
      try {
        const stats = await pc.getStats();
        stats.forEach((r) => {
          if (r.type !== 'candidate-pair' || !r.nominated || r.state !== 'succeeded') return;
          const l = stats.get(r.localCandidateId), m = stats.get(r.remoteCandidateId);
          if (l && m) d.pair = `${l.candidateType}/${l.protocol}→${m.candidateType} ${String(l.address || l.ip || '').includes(':') ? 'v6' : 'v4'}`;
        });
      } catch {}
    } else {
      this.p2pHint = nat === 'symmetric' ? '本机网络是对称型 NAT（手机流量、部分宽带常见），打洞不成功，已自动走服务器中转'
        : !st.rem.size ? '没有收到对方的网络地址，已自动走服务器中转，会在后台继续尝试直连'
        : '双方网络之间打洞不成功，已自动走服务器中转，会在后台继续尝试直连';
    }
    wsSend({ type: 'diag', to: this.id, ev: ok ? 'p2p-ok' : 'p2p-fail', d });
  }
  async onSignal(d) {
    try {
      if (d.want) {
        if (!this.initiator) return;
        const trying = this.pc && this.pc.connectionState !== 'failed' && Date.now() - this.connectStarted < 8000;
        if (!this.pc || (d.restart && !trying && !this.p2p)) this.connectP2P(true);
        return;
      }
      if (d.sdp && d.sdp.type === 'offer') {
        this.resetPC();
        this.connectStarted = Date.now();
        clearTimeout(this.p2pTimer);
        this.p2pTimer = setTimeout(() => this.p2pCheck(), P2P_GIVEUP);
        const pc = this.makePC(false, d.n);
        await pc.setRemoteDescription(d.sdp);
        await pc.setLocalDescription(await pc.createAnswer());
        if (this.pc !== pc) return;
        signal(this.id, { sdp: pc.localDescription, n: d.n });
        this.flushIce();
      } else if (d.sdp && d.sdp.type === 'answer') {
        if (this.pc && d.n === this.pcN && this.pc.signalingState === 'have-local-offer') {
          await this.pc.setRemoteDescription(d.sdp);
          this.flushIce();
        }
      } else if (d.ice) {
        if (!this.pc || d.n !== this.pcN) return;
        const c = candInfo(d.ice.candidate);
        if (c) this.pc.st.rem.add(c.kind);
        if (this.pc.remoteDescription) await this.pc.addIceCandidate(d.ice).catch(() => {});
        else this.iceQueue.push(d.ice);
      }
    } catch (e) { console.warn('signal', e); }
  }
  flushIce() {
    const q = this.iceQueue.splice(0);
    for (const c of q) this.pc?.addIceCandidate(c).catch(() => {});
  }
  waitOpen(ms) {
    if (this.p2p) return Promise.resolve(true);
    return new Promise((res) => {
      this.openWaiters.push(res);
      setTimeout(() => res(this.p2p), ms);
    });
  }
  // 发送前选链路：直连好了就用直连；正在连就等一小会儿；之前已经确认连不上的，不再让用户干等，直接中转
  async ensureLink() {
    if (this.p2p) return 'p2p';
    const left = P2P_WAIT - (Date.now() - this.connectStarted);
    if (this.pc && this.pc.connectionState !== 'failed' && left > 0) await this.waitOpen(left);
    if (this.p2p) return 'p2p';
    if (!relayAllowed) throw new Error('无法直连，且服务器未开启中转');
    return 'relay';
  }

  // --- 发送原语 ---
  sendMsg(obj, mode = this.mode) {
    if (mode === 'p2p') {
      if (!this.p2p) throw linkErr('直连已断开');
      this.dc.send(JSON.stringify(obj));
    } else if (!wsSend({ type: 'relay', to: this.id, data: obj })) throw linkErr('服务器连接已断开');
  }
  sendBin(u8, mode) {
    if (mode === 'p2p') {
      if (!this.p2p) throw linkErr('直连已断开');
      this.dc.send(u8);
    } else {
      if (!wsUp()) throw linkErr('服务器连接已断开');
      relaySendBin(this.id, u8);
    }
  }
  // 等到可以继续写：链路断了不报错，原地等它恢复（恢复后由 recover → 续传握手把进度对齐）
  async waitWritable(t) {
    for (;;) {
      if (t.cancelled) throw new Error(t.cancelReason || '已取消');
      if (t.rewind) return;
      if (!t.hold) {
        if (t.mode === 'p2p') {
          if (!this.p2p) this.startHold(t);
          else if (this.dc.bufferedAmount < 8 << 20 && t.sent - t.acked < 32 << 20) return;
        } else if (wsUp() && !this.away) {
          if (ws.bufferedAmount < 2 << 20 && t.sent - t.acked < 6 << 20) return;
        }
      }
      await Promise.race([new Promise((r) => (t.wake = r)), sleep(t.hold ? 250 : 40)]);
    }
  }
  waitReply(tid) { return new Promise((r) => this.waiters.set(tid, r)); }
  reply(tid, v) { const r = this.waiters.get(tid); if (r) { this.waiters.delete(tid); r(v); } }

  // --- 断线恢复 ---
  // 续传握手：发送方 rs（问：你收到哪了）→ 接收方暂停收数据并回 rp{第 i 个文件, 已收 got 字节, 编号 n}
  //          → 发送方从该位置重发，以 fh{i, off, n} 开头 → 接收方见到编号对得上的 fh 才恢复接收。
  // 握手期间路上的旧数据块全部丢弃，所以不会重复也不会错位；换链路（直连 ↔ 中转）也走同一套。
  recover() {
    if (!this.el) return;
    const t = this.out;
    if (t && t.phase === 'wait') { try { this.sendMsg(t.req); } catch {} }
    else if (t && t.phase !== 'link' && !(t.mode === 'p2p' && this.p2p)) {
      if (t.hold) this.askResume(); else this.startHold(t);
    }
    const inc = this.inc;
    if (inc && !(inc.via === 'p2p' && this.p2p)) this.offerResume(false);
    this.paint();
  }
  startHold(t) {
    if (t.hold) return;
    t.hold = true;
    t.k++;
    this.askResume();
    t.wake?.();
    this.paintSoon();
  }
  askResume() {
    const t = this.out;
    if (!t || !t.hold) return;
    try { this.sendMsg({ t: 'rs', tid: t.tid, k: t.k }); } catch {}
    clearTimeout(t.rsTimer);
    t.rsTimer = setTimeout(() => { if (this.out === t) this.askResume(); }, 4000);
  }
  // 发送方看门狗：长时间没有任何确认（数据在某处被悄悄丢了），主动对一次进度
  watch(t) {
    if (this.out !== t || t.hold || t.cancelled || this.away) return;
    if (Date.now() - t.ackAt > 30000 && (t.phase === 'finish' || t.sent > t.acked)) { t.ackAt = Date.now(); this.startHold(t); }
  }
  offerResume(fresh) {
    const inc = this.inc;
    if (!inc) return;
    if (fresh || !inc.paused) { inc.paused = true; inc.n++; }
    this.sendRp();
    this.paintSoon();
  }
  sendRp() {
    const inc = this.inc;
    if (!inc || !inc.paused) return;
    const cur = inc.cur;
    try { this.sendMsg({ t: 'rp', tid: inc.tid, n: inc.n, i: cur ? cur.i : inc.next, got: cur ? cur.got : 0 }); } catch {}
    clearTimeout(inc.rpTimer);
    inc.rpTimer = setTimeout(() => { if (this.inc === inc) this.sendRp(); }, 4000);
  }

  // --- 发送文件 ---
  sendFiles(fileList) {
    const files = [...fileList].filter((f) => f && typeof f.size === 'number' && !(relPath(f).includes('/') && JUNK.test(f.name)));
    if (!files.length) { toast('没有可发送的文件（文件夹是空的？）', 'error'); return; }
    if (files.length > MAX_FILES) { toast(`文件太多（${files.length} 个，最多 ${MAX_FILES} 个），请先压缩成一个文件再发送`, 'error'); return; }
    const metas = files.map(fileMeta);
    if (new TextEncoder().encode(JSON.stringify(metas)).length > MAX_REQ) { toast(`文件太多（${files.length} 个），请先压缩成一个文件再发送`, 'error'); return; }
    files.metas = metas;
    this.queue.push(files);
    if (!this.busy) this.runQueue();
    else toast(`已加入队列，当前传输完成后发送给 ${this.name}`);
  }
  async runQueue() {
    this.busy = true;
    while (this.queue.length) {
      const files = this.queue.shift();
      try { await this.doSend(files); }
      catch (e) { if (!/已取消/.test(e.message)) toast(`发送失败：${e.message}`, 'error'); }
      finally { this.out = null; this.paint(); }
    }
    this.busy = false;
  }
  async doSend(files) {
    const tid = rid(6);
    const total = files.reduce((s, f) => s + f.size, 0);
    const t = (this.out = { tid, files, total, sent: 0, acked: 0, cancelled: false, phase: 'link', start: 0, hold: false, rewind: null, rpN: 0, k: 0, ackAt: 0 });
    this.paint();
    t.mode = await this.ensureLink();
    if (t.cancelled) throw new Error('已取消');
    t.phase = 'wait';
    this.paint();
    t.req = { t: 'req', tid, total, files: files.metas || files.map(fileMeta) };
    try { this.sendMsg(t.req); } catch {} // 恰好断线也没关系：链路恢复时 recover() 会重发
    const ans = await this.waitReply(tid);
    if (ans === 'rej') { toast(`${this.name} 拒绝了文件`, 'error'); return; }
    if (ans === 'busy') { toast(`${this.name} 正在接收其他文件，请稍后再试`, 'error'); return; }
    if (ans !== 'acc') throw new Error(t.cancelReason || '已取消');
    if (this.p2p) t.mode = 'p2p';
    else if (relayAllowed) t.mode = 'relay';
    else throw new Error('直连已断开');
    t.phase = 'send';
    t.start = performance.now();
    t.ackAt = Date.now();
    const dog = setInterval(() => this.watch(t), 5000);
    try { await this.pump(t); }
    finally { clearInterval(dog); clearTimeout(t.rsTimer); }
    const secs = (performance.now() - t.start) / 1000;
    toast(`已发送给 ${this.name}（${fmtSize(total)}${secs > 1 ? '，' + fmtSize(total / secs) + '/s' : ''}）`, 'success');
    const bundle = bundleName(files.map(relPath));
    if (bundle) logItem({ dir: 'out', kind: 'file', folder: true, name: bundle, count: files.length, size: total, peer: this.name, mode: t.mode });
    else for (const f of files) logItem({ dir: 'out', kind: 'file', name: f.name, size: f.size, peer: this.name, mode: t.mode });
  }
  // 发送循环：位置 (i, off) 随时可以被接收方的 rp 拨回去（t.rewind），所以断线、换链路都只是“从对方说的位置接着发”
  async pump(t) {
    const { files, tid } = t;
    const before = [0];
    for (const f of files) before.push(before[before.length - 1] + f.size);
    let i = 0, off = 0, head = true, n, block = null, blockAt = 0, blockOf = -1;
    for (;;) {
      await this.waitWritable(t);
      if (t.rewind) {
        ({ i, off, n } = t.rewind);
        t.rewind = null;
        t.sent = t.acked = before[i] + off;
        t.mode = this.p2p ? 'p2p' : 'relay';
        t.phase = 'send';
        head = true;
        this.paintSoon();
        continue;
      }
      try {
        if (i >= files.length) {
          t.phase = 'finish';
          this.paint();
          const r = await this.waitReply(tid);
          if (r === 'done') return;
          if (r === 'rewind') continue;
          throw new Error(t.cancelReason || '已取消');
        }
        const f = files[i];
        if (head) { this.sendMsg({ t: 'fh', tid, i, off, n }, t.mode); head = false; n = undefined; }
        if (off >= f.size) { this.sendMsg({ t: 'fe', tid, i }, t.mode); i++; off = 0; head = true; continue; }
        if (blockOf !== i || off < blockAt || off >= blockAt + block.length) {
          const at = off, of = i;
          const b = new Uint8Array(await f.slice(at, at + READ_BLOCK).arrayBuffer());
          if (!b.length) throw new Error(`读取文件失败：${f.name}`);
          block = b; blockAt = at; blockOf = of;
          if (t.rewind || t.hold || t.cancelled) continue;
        }
        const p = off - blockAt;
        const c = block.subarray(p, p + CHUNK);
        this.sendBin(c, t.mode);
        off += c.length;
        t.sent += c.length;
        this.paintSoon();
      } catch (e) {
        if (!e.link || t.cancelled) throw e;
        this.startHold(t);
      }
    }
  }
  cancel() {
    const t = this.out;
    if (t) {
      t.cancelled = true;
      t.cancelReason = '已取消';
      try { this.sendMsg({ t: 'cancel', tid: t.tid }); } catch {}
      this.reply(t.tid, 'cancel');
      t.wake?.();
      toast('已取消发送');
    }
    this.queue.length = 0;
  }
  async sendText(text) {
    try {
      const mode = await this.ensureLink();
      if (mode === 'relay' && this.away) throw new Error('对方暂时掉线，等它重连后再发');
      this.sendMsg({ t: 'text', text }, mode);
      logItem({ dir: 'out', kind: 'text', text, peer: this.name });
      toast(`文字已发送给 ${this.name}`, 'success');
    } catch (e) { toast(`发送失败：${e.message}`, 'error'); }
  }

  // --- 接收 ---
  onMsg(m, via) {
    if (!m || typeof m !== 'object') return;
    switch (m.t) {
      case 'req': return this.onRequest(m);
      case 'acc': case 'rej': case 'busy': case 'done': return this.reply(m.tid, m.t);
      case 'ack':
        if (this.out && this.out.tid === m.tid) { this.out.acked = m.bytes; this.out.ackAt = Date.now(); this.out.wake?.(); }
        return;
      case 'rs': {
        const inc = this.inc;
        if (inc && inc.tid === m.tid) {
          const again = inc.paused && inc.lastK === m.k;
          inc.lastK = m.k;
          this.offerResume(!again);
        } else {
          try { this.sendMsg({ t: this.doneTids.has(m.tid) ? 'done' : 'cancel', tid: m.tid }); } catch {}
        }
        return;
      }
      case 'rp': {
        const t = this.out;
        if (!t || t.tid !== m.tid || !(m.n > t.rpN) || t.phase === 'link' || t.phase === 'wait') return;
        const i = m.i | 0, got = Number(m.got), f = t.files[i];
        if (!f || !(got >= 0 && got <= f.size)) {
          t.cancelled = true;
          t.cancelReason = '续传位置对不上';
          try { this.sendMsg({ t: 'cancel', tid: t.tid }); } catch {}
          this.reply(t.tid, 'cancel');
          t.wake?.();
          return;
        }
        t.rpN = m.n;
        t.rewind = { i, off: got, n: m.n };
        t.hold = false;
        t.ackAt = Date.now();
        clearTimeout(t.rsTimer);
        if (t.phase === 'finish') this.reply(t.tid, 'rewind');
        t.wake?.();
        this.paintSoon();
        return;
      }
      case 'cancel': {
        if (this.out && this.out.tid === m.tid) {
          this.out.cancelled = true;
          this.out.cancelReason = '对方取消了接收';
          this.reply(m.tid, 'cancel');
          this.out.wake?.();
          toast(`${this.name} 取消了接收`, 'error');
        }
        if (this.inc && this.inc.tid === m.tid) {
          this.inc = null;
          toast(`${this.name} 取消了发送`, 'error');
          this.paint();
        }
        if (this.pendingReq && this.pendingReq.tid === m.tid) { this.pendingReq.close(); this.pendingReq = null; }
        return;
      }
      case 'fh': {
        const inc = this.inc;
        if (!inc || inc.tid !== m.tid) return;
        // 暂停中只认编号对得上的续传头；正常接收中只认当前链路上的普通文件头（其余都是旧链路上迟到的）
        if (inc.paused ? m.n !== inc.n : (m.n != null || (inc.via && via !== inc.via))) return;
        const wantI = inc.cur ? inc.cur.i : inc.next, wantOff = inc.cur ? inc.cur.got : 0;
        if ((m.i | 0) !== wantI || (Number(m.off) || 0) !== wantOff) return this.offerResume(true);
        if (!inc.cur) inc.cur = { i: wantI, chunks: [], got: 0, crc: 0 };
        inc.paused = false;
        inc.via = via;
        clearTimeout(inc.rpTimer);
        this.paintSoon();
        return;
      }
      case 'fe': return this.finishFile(m, via);
      case 'text':
        if (typeof m.text !== 'string') return;
        logItem({ dir: 'in', kind: 'text', text: m.text.slice(0, 100000), peer: this.name });
        toast(`收到 ${this.name} 的文字`, 'success');
        notifyTitle();
        return;
    }
  }
  onRequest(m) {
    const files = (Array.isArray(m.files) ? m.files.slice(0, MAX_FILES) : []).map((f) => {
      const path = f && f.path ? safePath(f.path, '') : '';
      const name = safeName((f && f.name) || path.split('/').pop());
      return { name, path, size: Number(f && f.size) || 0, type: String((f && f.type) || '') };
    });
    if (!files.length) return;
    const bundle = bundleName(files.map((f) => f.path));
    // 对方断线恢复后会重发请求：已经在处理的同一个请求不重复弹窗
    if (this.pendingReq && this.pendingReq.tid === m.tid) return;
    if (this.inc && this.inc.tid === m.tid) { try { this.sendMsg({ t: 'acc', tid: m.tid }); } catch {} return; }
    if (this.doneTids.has(m.tid)) return;
    if (this.inc || this.pendingReq) { try { this.sendMsg({ t: 'busy', tid: m.tid }); } catch {} return; }
    const accept = () => {
      this.pendingReq = null;
      this.inc = { tid: m.tid, files, bundle, saved: [], total: Number(m.total) || 0, got: 0, lastAck: 0, cur: null, next: 0, paused: false, n: 0, lastK: -1, via: null, start: performance.now() };
      try { this.sendMsg({ t: 'acc', tid: m.tid }); } catch {} // 发不出去也先收着：对方恢复后会重发请求，届时再应答
      this.paint();
    };
    const trusted = store.get('trusted', []);
    if (store.get('autoAccept', false) || trusted.includes(this.info.key)) return accept();
    notifyTitle();
    const total = files.reduce((s, f) => s + (Number(f.size) || 0), 0);
    let remember = false;
    const dlg = openModal({
      title: '收到文件',
      body: `<div class="modal-sub">${bundle
          ? `<b>${esc(this.name)}</b> 想发送文件夹 <b>${esc(bundle)}</b>（${files.length} 个文件，共 ${fmtSize(total)}），收完后打包成 ZIP 下载`
          : `<b>${esc(this.name)}</b> 想发送 ${files.length} 个文件，共 ${fmtSize(total)}`}</div>
        <div class="file-list">${files.slice(0, 50).map((f) => `<div class="file-row"><span title="${esc(f.path || f.name)}">${esc(f.path || f.name)}</span><span>${fmtSize(Number(f.size) || 0)}</span></div>`).join('')}${files.length > 50 ? `<div class="file-row"><span>……还有 ${files.length - 50} 个</span><span></span></div>` : ''}</div>
        <label class="form-check modal-tip"><input type="checkbox" id="dlgTrust"> 以后自动接收这台设备的文件</label>`,
      buttons: [
        { label: '拒绝', onClick: () => { this.pendingReq = null; try { this.sendMsg({ t: 'rej', tid: m.tid }); } catch {} } },
        { label: '接收', primary: true, onClick: () => {
          if (remember) { const tr = store.get('trusted', []); if (!tr.includes(this.info.key)) { tr.push(this.info.key); store.set('trusted', tr.slice(-50)); } }
          accept();
        } },
      ],
      onCancel: () => { this.pendingReq = null; try { this.sendMsg({ t: 'rej', tid: m.tid }); } catch {} },
    });
    $('#dlgTrust', dlg.el).onchange = (e) => (remember = e.target.checked);
    this.pendingReq = { tid: m.tid, close: dlg.close };
  }
  onBin(buf, via) {
    const inc = this.inc;
    if (!inc || !inc.cur || inc.paused || via !== inc.via) return;
    inc.cur.chunks.push(buf);
    inc.cur.got += buf.byteLength;
    if (inc.bundle) inc.cur.crc = crc32(new Uint8Array(buf), inc.cur.crc);
    inc.got += buf.byteLength;
    if (inc.got - inc.lastAck >= ACK_EVERY) {
      inc.lastAck = inc.got;
      try { this.sendMsg({ t: 'ack', tid: inc.tid, bytes: inc.got }); } catch {}
    }
    this.paintSoon();
  }
  finishFile(m, via) {
    const inc = this.inc;
    if (!inc || inc.tid !== m.tid || !inc.cur || inc.paused || via !== inc.via || inc.cur.i !== (m.i | 0)) return;
    const meta = inc.files[inc.cur.i] || { name: 'file', type: '' };
    // 字节数对不上说明中途丢过数据：不保存残缺文件，让对方从我们实际收到的位置补发
    if (Number.isFinite(Number(meta.size)) && inc.cur.got !== Number(meta.size)) return this.offerResume(true);
    const name = safeName(meta.name);
    const blob = new Blob(inc.cur.chunks, { type: meta.type || 'application/octet-stream' });
    // 文件夹：先攒着，全部收完再打包成一个 ZIP（逐个下载会被浏览器拦成“下载多个文件”，也丢了目录结构）
    if (inc.bundle) inc.saved.push({ path: meta.path || name, blob, crc: inc.cur.crc });
    inc.next = inc.cur.i + 1;
    inc.cur = null;
    if (!inc.bundle) {
      const url = URL.createObjectURL(blob);
      download(url, name);
      logItem({ dir: 'in', kind: 'file', name, size: blob.size, peer: this.name, url });
    }
    if (inc.next >= inc.files.length) {
      this.doneTids.add(inc.tid);
      try { this.sendMsg({ t: 'ack', tid: inc.tid, bytes: inc.got }); this.sendMsg({ t: 'done', tid: inc.tid }); } catch {} // 丢了也没事：对方来问时会补一个 done
      const secs = (performance.now() - inc.start) / 1000;
      const speed = secs > 1 ? '（' + fmtSize(inc.got / secs) + '/s）' : '';
      if (inc.bundle) {
        const zip = makeZip(inc.saved);
        const zname = safeName(inc.bundle) + '.zip';
        const url = URL.createObjectURL(zip);
        download(url, zname);
        logItem({ dir: 'in', kind: 'file', folder: true, name: zname, count: inc.files.length, size: inc.got, peer: this.name, url });
        toast(`已收到 ${this.name} 的文件夹，共 ${inc.files.length} 个文件，已打包为 ZIP${speed}`, 'success');
      } else toast(`已收到 ${this.name} 的 ${inc.files.length} 个文件${speed}`, 'success');
      this.inc = null;
      notifyTitle();
    }
    this.paint();
  }
  cancelIncoming() {
    if (!this.inc) return;
    try { this.sendMsg({ t: 'cancel', tid: this.inc.tid }); } catch {}
    this.inc = null;
    toast('已取消接收');
    this.paint();
  }

  // --- 界面 ---
  render() {
    const el = document.createElement('div');
    el.className = 'peer';
    el.innerHTML = `
      <span class="via-tag" hidden>配对码</span>
      <div class="peer-ava">
        <svg class="ring" viewBox="0 0 88 88"><circle class="track" cx="44" cy="44" r="41"/><circle class="bar" cx="44" cy="44" r="41" stroke-dasharray="257.6" stroke-dashoffset="257.6"/></svg>
        <div class="ava-ico"></div>
      </div>
      <div class="peer-name"></div>
      <div class="peer-dev"></div>
      <div class="peer-state"><i></i><span></span></div>
      <div class="peer-actions"></div>`;
    el.addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (b?.dataset.act === 'text') return textDialog(this);
      if (b?.dataset.act === 'cancel') return this.out ? this.cancel() : this.cancelIncoming();
      if (b?.dataset.act === 'dir') return pickFiles(this, true);
      if (b?.dataset.act === 'file' || !b) { if (!this.out && !this.inc) pickFiles(this); }
    });
    $('#peers').appendChild(el);
    this.el = el;
    this.paint();
    return el;
  }
  paintSoon() {
    if (this._raf) return;
    this._raf = setTimeout(() => { this._raf = null; this.paint(); }, 120);
  }
  paint() {
    const el = this.el;
    if (!el) return;
    const info = this.info;
    $('.ava-ico', el).innerHTML = icon(devIcon(info.device), 30, 1.7);
    $('.peer-name', el).textContent = this.name;
    $('.peer-dev', el).textContent = devText(info.device);
    $('.via-tag', el).hidden = !(info.via || []).every((v) => v === 'room');
    let cls = '', txt = '', frac = 0, busy = false, tip = '';
    const t = this.out, inc = this.inc;
    // 走中转的传输需要双方都连着服务器；直连中的传输不受服务器连接影响
    const viaRelay = t ? t.mode !== 'p2p' || !this.p2p : inc ? inc.via !== 'p2p' || !this.p2p : !this.p2p;
    const down = viaRelay && (this.away ? '对方掉线，等待重连…' : !wsUp() ? '连接中断，正在重连…' : '');
    if (t) {
      busy = true;
      cls = 'run';
      if (t.phase === 'link') txt = '正在建立连接…';
      else if (t.phase === 'wait') txt = '等待对方接收…';
      else {
        frac = t.total ? Math.min(1, t.sent / t.total) : 1;
        const secs = (performance.now() - t.start) / 1000;
        if (t.hold) txt = `正在续传 ${Math.floor(frac * 100)}%…`;
        else if (t.phase === 'finish') txt = '等待对方保存…';
        else txt = `发送中 ${Math.floor(frac * 100)}%` + (secs > 0.5 ? ` · ${fmtSize(t.sent / secs)}/s` : '');
      }
      if (down && t.phase !== 'link') { txt = down; cls = 'warn'; }
    } else if (inc) {
      busy = true;
      cls = 'run';
      frac = inc.total ? inc.got / inc.total : 0;
      const secs = (performance.now() - inc.start) / 1000;
      txt = inc.paused ? `正在续传 ${Math.floor(frac * 100)}%…` : `接收中 ${Math.floor(frac * 100)}%` + (secs > 0.5 ? ` · ${fmtSize(inc.got / secs)}/s` : '');
      if (down) { txt = down; cls = 'warn'; }
    } else if (this.p2p) { cls = 'ok'; txt = '直连就绪'; }
    else if (down) { cls = 'warn'; txt = down; }
    else if (!this.p2pTries && Date.now() - this.connectStarted < P2P_WAIT && !(this.pc && this.pc.connectionState === 'failed')) { txt = '正在直连…'; }
    else if (relayAllowed) { cls = 'warn'; txt = '经服务器中转'; tip = this.p2pHint; }
    else { cls = 'warn'; txt = '无法直连'; tip = this.p2pHint; }
    const st = $('.peer-state', el);
    st.className = 'peer-state ' + cls;
    st.title = tip;
    st.lastElementChild.textContent = txt;
    el.classList.toggle('busy', busy);
    el.classList.toggle('away', this.away);
    $('.ring .bar', el).style.strokeDashoffset = String(257.6 * (1 - Math.min(1, frac)));
    const acts = busy
      ? `<button class="btn btn-sm" data-act="cancel">取消</button>`
      : `<button class="btn btn-primary btn-sm" data-act="file">发文件</button>${canPickDir ? '<button class="btn btn-sm" data-act="dir">文件夹</button>' : ''}<button class="btn btn-sm" data-act="text">发文字</button>`;
    const box = $('.peer-actions', el);
    if (box.dataset.busy !== String(busy)) { box.innerHTML = acts; box.dataset.busy = String(busy); syncWakeLock(); }
  }
  destroy(reason) {
    if (this.out) { this.out.cancelled = true; this.out.cancelReason = reason; this.reply(this.out.tid, 'cancel'); this.out.wake?.(); }
    for (const tid of [...this.waiters.keys()]) this.reply(tid, 'cancel');
    if (this.inc) toast(`${this.name}：${reason}，接收中断`, 'error');
    this.inc = null;
    if (this.pendingReq) this.pendingReq.close();
    this.queue.length = 0;
    clearTimeout(this.p2pTimer);
    this.resetPC();
    this.el?.remove();
    this.el = null;
    syncWakeLock();
  }
}

// ---------- 界面：通用 ----------
function toast(msg, kind = '') {
  const host = $('#toasts');
  const el = document.createElement('div');
  el.className = 'toast' + (kind ? ' toast-' + kind : '');
  el.textContent = msg;
  host.appendChild(el);
  requestAnimationFrame(() => el.classList.add('show'));
  setTimeout(() => { el.classList.remove('show'); setTimeout(() => el.remove(), 400); }, 3200);
}

function openModal({ title, body, buttons = [], onCancel, onOpen }) {
  const ov = document.createElement('div');
  ov.className = 'modal-overlay';
  ov.innerHTML = `<div class="modal" role="dialog" aria-modal="true">
    <div class="modal-header"><span>${esc(title)}</span><button class="modal-x" aria-label="关闭">${icon('x', 14, 2.2)}</button></div>
    <div class="modal-body">${body}</div>
    <div class="modal-footer"></div></div>`;
  const foot = $('.modal-footer', ov);
  let closed = false;
  const close = () => { if (closed) return; closed = true; ov.remove(); document.removeEventListener('keydown', onKey, true); };
  const cancel = () => { if (closed) return; close(); onCancel && onCancel(); };
  for (const b of buttons) {
    const btn = document.createElement('button');
    btn.className = 'btn' + (b.primary ? ' btn-primary' : '');
    btn.textContent = b.label;
    btn.onclick = () => { if (b.onClick && b.onClick() === false) return; close(); };
    foot.appendChild(btn);
  }
  const onKey = (e) => {
    if (e.key === 'Escape') { e.preventDefault(); cancel(); }
    else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey || e.target.tagName !== 'TEXTAREA')) {
      const p = [...foot.children].find((b, i) => buttons[i].primary);
      if (p) { e.preventDefault(); p.click(); }
    }
  };
  document.addEventListener('keydown', onKey, true);
  $('.modal-x', ov).onclick = cancel;
  ov.addEventListener('mousedown', (e) => { if (e.target === ov) cancel(); });
  document.body.appendChild(ov);
  onOpen && onOpen(ov);
  return { el: ov, close };
}

function download(url, name) {
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; } catch {}
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.cssText = 'position:fixed;opacity:0';
  document.body.appendChild(ta);
  ta.select();
  let ok = false;
  try { ok = document.execCommand('copy'); } catch {}
  ta.remove();
  return ok;
}

let titleTimer = null;
function notifyTitle() {
  if (!document.hidden || titleTimer) return;
  const base = '网页快传';
  let on = false;
  titleTimer = setInterval(() => { on = !on; document.title = on ? '【新消息】' + base : base; }, 1000);
}
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && titleTimer) { clearInterval(titleTimer); titleTimer = null; document.title = '网页快传'; }
});

// ---------- 记录 ----------
const logUrls = [];
function logItem(it) {
  $('#logEmpty').hidden = true;
  const el = document.createElement('div');
  el.className = 'item ' + it.dir;
  const who = it.dir === 'in' ? `来自 ${esc(it.peer)}` : `发给 ${esc(it.peer)}`;
  const via = it.mode === 'relay' ? ' · 中转' : '';
  if (it.kind === 'file') {
    el.innerHTML = `<div class="item-ico">${icon(it.folder ? 'folder' : 'file', 17)}</div><div class="item-main">
      <div class="item-title" title="${esc(it.name)}">${esc(it.name)}</div>
      <div class="item-meta">${it.count ? it.count + ' 个文件 · ' : ''}${fmtSize(it.size)} · ${who} · ${fmtTime()}${via}</div>
      ${it.url ? `<div class="item-actions"><button class="btn btn-sm" data-a="dl">再次下载</button></div>` : ''}</div>`;
    if (it.url) { logUrls.push(it.url); $('[data-a=dl]', el).onclick = () => download(it.url, it.name); }
  } else {
    el.innerHTML = `<div class="item-ico">${icon('text', 17)}</div><div class="item-main">
      <div class="item-meta" style="margin:0 0 4px">${who} · ${fmtTime()}</div>
      <div class="item-text"></div>
      <div class="item-actions"><button class="btn btn-sm${it.dir === 'in' ? ' btn-primary' : ''}" data-a="cp">复制</button></div></div>`;
    $('.item-text', el).textContent = it.text;
    $('[data-a=cp]', el).onclick = async () => {
      const ok = await copyText(it.text);
      toast(ok ? '已复制' : '复制失败，请手动选择文字', ok ? 'success' : 'error');
    };
  }
  $('#log').prepend(el);
}
$('#btnClear').onclick = () => {
  logUrls.splice(0).forEach((u) => URL.revokeObjectURL(u));
  $('#log').querySelectorAll('.item').forEach((e) => e.remove());
  $('#logEmpty').hidden = false;
};

// ---------- 发送入口 ----------
let pickTarget = null;
function pickFiles(peer, dir = false) {
  pickTarget = peer;
  const inp = $(dir ? '#dirPick' : '#filePick');
  inp.value = '';
  inp.click();
}
for (const sel of ['#filePick', '#dirPick']) {
  $(sel).onchange = (e) => {
    const files = [...e.target.files];
    if (pickTarget && peers.get(pickTarget.id) === pickTarget) {
      if (files.length) pickTarget.sendFiles(files);
      else if (sel === '#dirPick') toast('这个文件夹是空的', 'error');
    }
    pickTarget = null;
  };
}

function textDialog(peer, initial = '') {
  openModal({
    title: `发文字给 ${peer.name}`,
    body: `<textarea class="input" id="dlgText" placeholder="输入或粘贴文字、链接…" maxlength="100000"></textarea><div class="modal-tip">按 Ctrl + Enter 发送</div>`,
    buttons: [
      { label: '取消' },
      { label: '发送', primary: true, onClick: () => {
        const v = $('#dlgText').value;
        if (!v.trim()) { toast('请输入文字'); return false; }
        peer.sendText(v);
      } },
    ],
    onOpen: (ov) => { const ta = $('#dlgText', ov); ta.value = initial; ta.focus(); },
  });
}

const onlyPeer = () => (peers.size === 1 ? [...peers.values()][0] : null);

// ---------- 拖拽发送 ----------
// 文件、文件夹、选中的文字或链接都能拖。拖动时页面变暗、设备卡片浮在上面：
// 拖到哪台设备上就发给哪台；只有一台设备时，松在页面任意位置都发给它。
let innerDrag = false; // 页面内自己的拖动（比如拖记录里的文字），不当成发送
document.addEventListener('dragstart', () => (innerDrag = true));
document.addEventListener('dragend', () => (innerDrag = false));
function dragKind(e) {
  if (innerDrag) return '';
  const ty = [...(e.dataTransfer?.types || [])];
  return ty.includes('Files') ? 'files' : ty.includes('text/plain') || ty.includes('text/uri-list') ? 'text' : '';
}
function dropTarget(e) {
  const card = e.target.closest?.('.peer');
  return (card && [...peers.values()].find((p) => p.el === card)) || onlyPeer();
}
let dragTimer = null;
let dragCard = null;
function endDrag() {
  clearTimeout(dragTimer);
  document.body.classList.remove('dragging');
  $('#dropMask').hidden = true;
  dragCard?.classList.remove('drag');
  dragCard = null;
}
document.addEventListener('dragover', (e) => {
  const kind = dragKind(e);
  if (!kind) return;
  e.preventDefault();
  const p = dropTarget(e);
  e.dataTransfer.dropEffect = p ? 'copy' : 'none';
  $('#dropText').textContent = p ? `松开即可${kind === 'text' ? '把文字' : ''}发送给 ${p.name}` : peers.size ? '拖到要发送的设备上' : '还没有发现其他设备';
  $('#dropMask').hidden = false;
  document.body.classList.add('dragging');
  if (dragCard !== (p?.el || null)) { dragCard?.classList.remove('drag'); dragCard = p?.el || null; dragCard?.classList.add('drag'); }
  clearTimeout(dragTimer);
  dragTimer = setTimeout(endDrag, 200); // 拖出窗口或按 Esc 取消时没有事件，靠这个收尾
});
document.addEventListener('drop', (e) => {
  const kind = dragKind(e);
  if (!kind) return;
  e.preventDefault();
  const p = dropTarget(e);
  endDrag();
  if (!p) { toast(peers.size ? '有多台设备，请拖到具体的设备上' : '还没有发现其他设备'); return; }
  if (kind === 'text') {
    const text = e.dataTransfer.getData('text/plain') || e.dataTransfer.getData('text/uri-list');
    if (text.trim()) textDialog(p, text);
    return;
  }
  collectDrop(e.dataTransfer).then((files) => p.sendFiles(files)).catch((err) => toast(err.message || '读取文件失败', 'error'));
});

// 拖进来的可能有文件夹：顺着目录树把里面的文件都找出来，带上相对路径
async function collectDrop(dt) {
  // 这两样必须在 drop 事件里同步取，await 之后就拿不到了
  const entries = [...(dt.items || [])].filter((i) => i.kind === 'file').map((i) => i.webkitGetAsEntry?.()).filter(Boolean);
  const loose = [...dt.files];
  if (!entries.some((en) => en.isDirectory)) return loose;
  const out = [];
  const slow = setTimeout(() => toast('正在读取文件夹…'), 500);
  try { for (const en of entries) await walkEntry(en, out); }
  finally { clearTimeout(slow); }
  return out;
}
async function walkEntry(en, out) {
  if (out.length > MAX_FILES) throw new Error(`文件超过 ${MAX_FILES} 个，请先压缩成一个文件再发送`);
  if (en.isFile) {
    const f = await new Promise((res, rej) => en.file(res, rej));
    f.relPath = en.fullPath.replace(/^\/+/, '');
    out.push(f);
  } else if (en.isDirectory) {
    const rd = en.createReader();
    for (;;) {
      const batch = await new Promise((res, rej) => rd.readEntries(res, rej)); // 每次最多返回 100 个，要读到空为止
      if (!batch.length) break;
      for (const c of batch) await walkEntry(c, out);
    }
  }
}

// 粘贴：Ctrl+V 文件直接发送，文字弹出发送框
document.addEventListener('paste', (e) => {
  if (e.target.closest && e.target.closest('input, textarea, .modal-overlay')) return;
  const files = [...(e.clipboardData?.files || [])];
  const text = e.clipboardData?.getData('text') || '';
  if (!files.length && !text) return;
  const p = onlyPeer();
  if (!p) { toast(peers.size ? '有多台设备，请点击设备上的按钮发送' : '还没有发现其他设备'); return; }
  e.preventDefault();
  if (files.length) p.sendFiles(files);
  else textDialog(p, text);
});

// ---------- 顶栏 / 设置 ----------
function setConn(s) {
  const el = $('#conn');
  el.className = 'status ' + (s === 'ok' ? 'ok' : s === 'bad' ? 'bad' : '');
  el.lastElementChild.textContent = s === 'ok' ? '已连接' : s === 'bad' ? '已断开，重连中…' : '连接中…';
}

function renderEmpty() {
  $('#empty').hidden = peers.size > 0;
  $('#peers').hidden = peers.size === 0;
}

function renderMe() {
  $('#myName').textContent = me.name;
  $('#meIco').innerHTML = icon(devIcon(me.device), 16);
  const r = $('#room');
  r.hidden = !me.room;
  r.textContent = '配对码 ' + me.room;
  $('#btnRoom').classList.toggle('on', !!me.room);
}

$('#myName').onclick = () => {
  openModal({
    title: '修改设备名称',
    body: `<input class="input" id="dlgName" maxlength="32"><div class="modal-tip">其他设备会看到这个名字，比如“办公室电脑”“我的手机”。</div>`,
    buttons: [
      { label: '取消' },
      { label: '保存', primary: true, onClick: () => {
        const v = $('#dlgName').value.trim();
        if (!v) return false;
        me.name = v;
        store.set('name', v);
        wsSend({ type: 'rename', name: v });
        renderMe();
      } },
    ],
    onOpen: (ov) => { const i = $('#dlgName', ov); i.value = me.name; i.select(); },
  });
};

$('#btnRoom').innerHTML = icon('link', 17);
$('#btnRoom').onclick = () => {
  const gen = () => Array.from(crypto.getRandomValues(new Uint8Array(6)), (b) => 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[b % 32]).join('');
  const setRoom = (code) => {
    me.room = code;
    store.set('room', code);
    wsSend({ type: 'room', room: code });
    renderMe();
  };
  openModal({
    title: '配对码',
    body: `<div class="modal-sub">同一 Wi-Fi 下一般能自动发现。如果看不到对方（比如一台用手机流量、或公司网络有多个出口），在两台设备上输入<b>同一个配对码</b>即可互相看到。</div>
      <div style="margin-top:14px"><input class="input code-input" id="dlgRoom" maxlength="16" placeholder="输入配对码" autocomplete="off"></div>
      <div class="modal-tip">配对码会记在本机，下次打开自动加入。${me.room ? '当前已加入：<b>' + esc(me.room) + '</b>' : ''}</div>`,
    buttons: me.room
      ? [{ label: '退出配对', onClick: () => { setRoom(''); toast('已退出配对'); } }, { label: '加入', primary: true, onClick: join }]
      : [{ label: '随机生成', onClick: () => { $('#dlgRoom').value = gen(); return false; } }, { label: '加入', primary: true, onClick: join }],
    onOpen: (ov) => { const i = $('#dlgRoom', ov); i.value = me.room; i.focus(); i.select(); },
  });
  function join() {
    const v = $('#dlgRoom').value.trim().toUpperCase();
    if (!/^[A-Z0-9]{4,16}$/.test(v)) { toast('配对码为 4–16 位字母或数字', 'error'); return false; }
    setRoom(v);
    toast('已加入配对 ' + v + '，在另一台设备输入同样的码', 'success');
  }
};

function paintTheme() {
  const dark = document.documentElement.dataset.theme === 'dark';
  $('#btnTheme').innerHTML = icon(dark ? 'sun' : 'moon', 17);
  document.querySelector('meta[name=theme-color]').content = dark ? '#000000' : '#f5f5f7';
}
$('#btnTheme').onclick = () => {
  const t = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = t;
  store.set('theme', t);
  paintTheme();
};

$('#optAuto').checked = store.get('autoAccept', false);
$('#optAuto').onchange = (e) => store.set('autoAccept', e.target.checked);

$('#pageUrl').textContent = location.host + location.pathname.replace(/index\.html$/, '');
$('.url-copy').innerHTML = icon('copy', 14, 2);
$('#btnCopyUrl').onclick = async () => toast((await copyText(location.origin + location.pathname)) ? '网址已复制' : '复制失败', 'success');
$('.drop-ico').innerHTML = icon('upload', 26, 1.8);

// 离开页面前提醒（正在传输时）
window.addEventListener('beforeunload', (e) => {
  if ([...peers.values()].some((p) => p.out || p.inc)) { e.preventDefault(); e.returnValue = ''; }
});

paintTheme();
renderMe();
renderEmpty();
connectServer();
