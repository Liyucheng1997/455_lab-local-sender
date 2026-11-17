'use strict';
/* 网页快传 · 前端
 * 发现：连上服务器后，服务器按出口 IP 把同一网络的设备推送过来
 * 传输：优先 WebRTC DataChannel 点对点直连；连不上时经服务器 WebSocket 中转
 * 协议（JSON 控制消息 + 二进制数据块）：
 *   req{tid,files,total} → acc/rej → [fh{i} 数据块... fe{i}]×N → done；接收方每 1MB 回 ack；任一方可 cancel
 *   text{text}
 */

// ---------- 常量与工具 ----------
const CHUNK = 64 * 1024;
const READ_BLOCK = 2 * 1024 * 1024;
const ACK_EVERY = 1024 * 1024;
const P2P_WAIT = 6000;

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

// ---------- 图标（lucide 风格） ----------
const P = {
  monitor: '<rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4"/>',
  phone: '<rect x="6" y="2" width="12" height="20" rx="2.5"/><path d="M11 18h2"/>',
  tablet: '<rect x="4" y="2" width="16" height="20" rx="2.5"/><path d="M11 18h2"/>',
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
let ws = null;
let wsRetry = 0;
let iceServers = [{ urls: 'stun:stun.miwifi.com:3478' }, { urls: 'stun:stun.l.google.com:19302' }];
let relayAllowed = true;
const peers = new Map();

function wsSend(obj) {
  if (ws && ws.readyState === 1) { ws.send(JSON.stringify(obj)); return true; }
  return false;
}
function signal(to, data) { wsSend({ type: 'signal', to, data }); }

function connectServer() {
  setConn('wait');
  ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
  ws.binaryType = 'arraybuffer';
  ws.onopen = () => {
    wsRetry = 0;
    wsSend({ type: 'join', key: me.key, name: me.name, device: me.device, room: me.room });
  };
  ws.onmessage = (e) => {
    if (typeof e.data !== 'string') return onRelayBinary(e.data);
    let m;
    try { m = JSON.parse(e.data); } catch { return; }
    if (m.type === 'welcome') {
      me.id = m.id;
      if (Array.isArray(m.iceServers) && m.iceServers.length) iceServers = m.iceServers;
      relayAllowed = m.relay !== false;
      setConn('ok');
    } else if (m.type === 'peers') updatePeers(m.peers || []);
    else if (m.type === 'signal') peers.get(m.from)?.onSignal(m.data || {});
    else if (m.type === 'relay') peers.get(m.from)?.onMsg(m.data || {});
  };
  ws.onclose = () => {
    me.id = null;
    setConn('bad');
    for (const p of [...peers.values()]) p.destroy('服务器连接断开');
    peers.clear();
    renderEmpty();
    setTimeout(connectServer, Math.min(1000 * 2 ** wsRetry++, 10000));
  };
}
setInterval(() => wsSend({ type: 'ping' }), 25000);

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
  peers.get(from)?.onBin(buf.slice(1 + n));
}

function updatePeers(list) {
  const seen = new Set();
  for (const info of list) {
    seen.add(info.id);
    const p = peers.get(info.id);
    if (p) { p.info = info; p.paint(); }
    else peers.set(info.id, new Peer(info));
  }
  for (const [id, p] of peers) if (!seen.has(id)) { p.destroy('对方已离开'); peers.delete(id); }
  renderEmpty();
}

// ---------- 对等设备 ----------
class Peer {
  constructor(info) {
    this.info = info;
    this.id = info.id;
    this.pc = null;
    this.dc = null;
    this.iceQueue = [];
    this.queue = [];
    this.busy = false;
    this.out = null; // 正在发送
    this.inc = null; // 正在接收
    this.waiters = new Map(); // tid -> resolve
    this.openWaiters = [];
    this.connectStarted = 0;
    this.el = this.render();
    this.connectP2P();
  }
  get name() { return this.info.name || '设备'; }
  get p2p() { return !!this.dc && this.dc.readyState === 'open'; }
  get mode() { return this.p2p ? 'p2p' : 'relay'; }

  // --- WebRTC ---
  connectP2P(restart = false) {
    if (!me.id || typeof RTCPeerConnection === 'undefined') return;
    if (this.pc && !restart) return;
    this.connectStarted = Date.now();
    if (me.id < this.id) { this.resetPC(); this.makePC(true); }
    else signal(this.id, { want: 1, restart });
    this.paintSoon();
    setTimeout(() => this.paint(), P2P_WAIT + 100);
  }
  makePC(initiator) {
    const pc = (this.pc = new RTCPeerConnection({ iceServers }));
    pc.onicecandidate = (e) => { if (e.candidate) signal(this.id, { ice: e.candidate }); };
    pc.onconnectionstatechange = () => {
      if (this.pc === pc && (pc.connectionState === 'failed' || pc.connectionState === 'closed')) this.resetPC();
      this.paintSoon();
    };
    if (initiator) {
      this.bindDC(pc.createDataChannel('ls', { ordered: true }));
      pc.createOffer()
        .then((o) => pc.setLocalDescription(o))
        .then(() => signal(this.id, { sdp: pc.localDescription }))
        .catch((e) => console.warn('offer', e));
    } else {
      pc.ondatachannel = (e) => this.bindDC(e.channel);
    }
    return pc;
  }
  bindDC(dc) {
    dc.binaryType = 'arraybuffer';
    dc.bufferedAmountLowThreshold = 1 << 20;
    dc.onopen = () => {
      this.dc = dc;
      this.openWaiters.splice(0).forEach((r) => r(true));
      this.paintSoon();
    };
    dc.onclose = () => { if (this.dc === dc) this.dc = null; this.paintSoon(); };
    dc.onbufferedamountlow = () => this.out?.wake?.();
    dc.onmessage = (e) => (typeof e.data === 'string' ? this.onMsg(JSON.parse(e.data)) : this.onBin(e.data));
    this.dc = dc;
  }
  resetPC() {
    const pc = this.pc;
    this.pc = null;
    this.dc = null;
    if (pc) try { pc.close(); } catch {}
  }
  async onSignal(d) {
    try {
      if (d.want) {
        if (me.id < this.id && (!this.pc || d.restart)) { this.connectStarted = Date.now(); this.resetPC(); this.makePC(true); }
        return;
      }
      if (d.sdp && d.sdp.type === 'offer') {
        this.resetPC();
        this.connectStarted = Date.now();
        const pc = this.makePC(false);
        await pc.setRemoteDescription(d.sdp);
        await pc.setLocalDescription(await pc.createAnswer());
        signal(this.id, { sdp: pc.localDescription });
        this.flushIce();
      } else if (d.sdp && d.sdp.type === 'answer') {
        if (this.pc && this.pc.signalingState === 'have-local-offer') {
          await this.pc.setRemoteDescription(d.sdp);
          this.flushIce();
        }
      } else if (d.ice) {
        if (this.pc && this.pc.remoteDescription) await this.pc.addIceCandidate(d.ice).catch(() => {});
        else this.iceQueue.push(d.ice);
      }
    } catch (e) { console.warn('signal', e); }
  }
  flushIce() {
    const q = this.iceQueue.splice(0);
    for (const c of q) this.pc.addIceCandidate(c).catch(() => {});
  }
  waitOpen(ms) {
    if (this.p2p) return Promise.resolve(true);
    return new Promise((res) => {
      this.openWaiters.push(res);
      setTimeout(() => res(this.p2p), ms);
    });
  }
  async ensureLink() {
    if (this.p2p) return 'p2p';
    const st = this.pc && this.pc.connectionState;
    const fresh = this.pc && Date.now() - this.connectStarted < P2P_WAIT && st !== 'failed';
    if (!fresh) this.connectP2P(true);
    await this.waitOpen(Math.max(1500, P2P_WAIT - (Date.now() - this.connectStarted)));
    if (this.p2p) return 'p2p';
    if (!relayAllowed) throw new Error('无法直连，且服务器未开启中转');
    return 'relay';
  }

  // --- 发送原语 ---
  sendMsg(obj, mode = this.mode) {
    if (mode === 'p2p') {
      if (!this.p2p) throw new Error('直连已断开');
      this.dc.send(JSON.stringify(obj));
    } else if (!wsSend({ type: 'relay', to: this.id, data: obj })) throw new Error('服务器连接已断开');
  }
  sendBin(u8, mode) {
    if (mode === 'p2p') {
      if (!this.p2p) throw new Error('直连已断开');
      this.dc.send(u8);
    } else {
      if (!ws || ws.readyState !== 1) throw new Error('服务器连接已断开');
      relaySendBin(this.id, u8);
    }
  }
  async waitWritable(t) {
    for (;;) {
      if (t.cancelled) throw new Error(t.cancelReason || '已取消');
      let buffered, limit, win;
      if (t.mode === 'p2p') {
        if (!this.p2p) throw new Error('直连已断开');
        buffered = this.dc.bufferedAmount; limit = 8 << 20; win = 32 << 20;
      } else {
        if (!ws || ws.readyState !== 1) throw new Error('服务器连接已断开');
        buffered = ws.bufferedAmount; limit = 2 << 20; win = 6 << 20;
      }
      if (buffered < limit && t.sent - t.acked < win) return;
      await Promise.race([new Promise((r) => (t.wake = r)), sleep(40)]);
    }
  }
  waitReply(tid) { return new Promise((r) => this.waiters.set(tid, r)); }
  reply(tid, v) { const r = this.waiters.get(tid); if (r) { this.waiters.delete(tid); r(v); } }

  // --- 发送文件 ---
  sendFiles(fileList) {
    const files = [...fileList].filter((f) => f && typeof f.size === 'number');
    if (!files.length) return;
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
    const t = (this.out = { tid, files, total, sent: 0, acked: 0, cancelled: false, phase: 'link', start: 0 });
    this.paint();
    t.mode = await this.ensureLink();
    if (t.cancelled) throw new Error('已取消');
    t.phase = 'wait';
    this.paint();
    this.sendMsg({ t: 'req', tid, total, files: files.map((f) => ({ name: f.name, size: f.size, type: f.type })) }, t.mode);
    const ans = await this.waitReply(tid);
    if (ans === 'rej') { toast(`${this.name} 拒绝了文件`, 'error'); return; }
    if (ans === 'busy') { toast(`${this.name} 正在接收其他文件，请稍后再试`, 'error'); return; }
    if (ans !== 'acc') throw new Error(t.cancelReason || '已取消');
    if (this.p2p) t.mode = 'p2p';
    else if (relayAllowed) t.mode = 'relay';
    else throw new Error('直连已断开');
    t.phase = 'send';
    t.start = performance.now();
    for (let i = 0; i < files.length; i++) {
      const f = files[i];
      this.sendMsg({ t: 'fh', tid, i }, t.mode);
      for (let off = 0; off < f.size;) {
        const block = new Uint8Array(await f.slice(off, off + READ_BLOCK).arrayBuffer());
        if (!block.length) throw new Error(`读取文件失败：${f.name}`);
        for (let p = 0; p < block.length; p += CHUNK) {
          await this.waitWritable(t);
          const c = block.subarray(p, p + CHUNK);
          this.sendBin(c, t.mode);
          t.sent += c.length;
        }
        off += block.length;
        this.paintSoon();
      }
      this.sendMsg({ t: 'fe', tid, i }, t.mode);
    }
    t.phase = 'finish';
    this.paint();
    const done = await this.waitReply(tid);
    if (done !== 'done') throw new Error(t.cancelReason || '已取消');
    const secs = (performance.now() - t.start) / 1000;
    toast(`已发送给 ${this.name}（${fmtSize(total)}${secs > 1 ? '，' + fmtSize(total / secs) + '/s' : ''}）`, 'success');
    for (const f of files) logItem({ dir: 'out', kind: 'file', name: f.name, size: f.size, peer: this.name, mode: t.mode });
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
      this.sendMsg({ t: 'text', text }, mode);
      logItem({ dir: 'out', kind: 'text', text, peer: this.name });
      toast(`文字已发送给 ${this.name}`, 'success');
    } catch (e) { toast(`发送失败：${e.message}`, 'error'); }
  }

  // --- 接收 ---
  onMsg(m) {
    if (!m || typeof m !== 'object') return;
    switch (m.t) {
      case 'req': return this.onRequest(m);
      case 'acc': case 'rej': case 'busy': case 'done': return this.reply(m.tid, m.t);
      case 'ack':
        if (this.out && this.out.tid === m.tid) { this.out.acked = m.bytes; this.out.wake?.(); }
        return;
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
      case 'fh':
        if (this.inc && this.inc.tid === m.tid) this.inc.cur = { i: m.i, chunks: [], got: 0 };
        return;
      case 'fe': return this.finishFile(m);
      case 'text':
        if (typeof m.text !== 'string') return;
        logItem({ dir: 'in', kind: 'text', text: m.text.slice(0, 100000), peer: this.name });
        toast(`收到 ${this.name} 的文字`, 'success');
        notifyTitle();
        return;
    }
  }
  onRequest(m) {
    const files = Array.isArray(m.files) ? m.files.slice(0, 1000) : [];
    if (!files.length) return;
    if (this.inc || this.pendingReq) { try { this.sendMsg({ t: 'busy', tid: m.tid }); } catch {} return; }
    const accept = () => {
      this.pendingReq = null;
      this.inc = { tid: m.tid, files, total: Number(m.total) || 0, got: 0, lastAck: 0, cur: null, saved: [], start: performance.now() };
      try { this.sendMsg({ t: 'acc', tid: m.tid }); } catch (e) { this.inc = null; toast('接收失败：' + e.message, 'error'); }
      this.paint();
    };
    const trusted = store.get('trusted', []);
    if (store.get('autoAccept', false) || trusted.includes(this.info.key)) return accept();
    notifyTitle();
    const total = files.reduce((s, f) => s + (Number(f.size) || 0), 0);
    let remember = false;
    const dlg = openModal({
      title: '收到文件',
      body: `<div class="modal-sub"><b>${esc(this.name)}</b> 想发送 ${files.length} 个文件，共 ${fmtSize(total)}</div>
        <div class="file-list">${files.slice(0, 50).map((f) => `<div class="file-row"><span>${esc(f.name)}</span><span>${fmtSize(Number(f.size) || 0)}</span></div>`).join('')}${files.length > 50 ? `<div class="file-row"><span>……还有 ${files.length - 50} 个</span><span></span></div>` : ''}</div>
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
  onBin(buf) {
    const inc = this.inc;
    if (!inc || !inc.cur) return;
    inc.cur.chunks.push(buf);
    inc.cur.got += buf.byteLength;
    inc.got += buf.byteLength;
    if (inc.got - inc.lastAck >= ACK_EVERY) {
      inc.lastAck = inc.got;
      try { this.sendMsg({ t: 'ack', tid: inc.tid, bytes: inc.got }); } catch {}
    }
    this.paintSoon();
  }
  finishFile(m) {
    const inc = this.inc;
    if (!inc || inc.tid !== m.tid || !inc.cur) return;
    const meta = inc.files[inc.cur.i] || { name: 'file', type: '' };
    const name = String(meta.name || 'file').replace(/[\\/:*?"<>|]/g, '_').slice(0, 200) || 'file';
    const blob = new Blob(inc.cur.chunks, { type: meta.type || 'application/octet-stream' });
    inc.cur = null;
    const url = URL.createObjectURL(blob);
    download(url, name);
    logItem({ dir: 'in', kind: 'file', name, size: blob.size, peer: this.name, url });
    if (m.i >= inc.files.length - 1) {
      try { this.sendMsg({ t: 'ack', tid: inc.tid, bytes: inc.got }); this.sendMsg({ t: 'done', tid: inc.tid }); } catch {}
      const secs = (performance.now() - inc.start) / 1000;
      toast(`已收到 ${this.name} 的 ${inc.files.length} 个文件${secs > 1 ? '（' + fmtSize(inc.got / secs) + '/s）' : ''}`, 'success');
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
      if (b?.dataset.act === 'file' || !b) { if (!this.out && !this.inc) pickFiles(this); }
    });
    el.addEventListener('dragenter', (e) => { if (hasFiles(e)) { e.preventDefault(); el.classList.add('drag'); } });
    el.addEventListener('dragover', (e) => { if (hasFiles(e)) { e.preventDefault(); e.stopPropagation(); e.dataTransfer.dropEffect = 'copy'; el.classList.add('drag'); hideMask(); } });
    el.addEventListener('dragleave', (e) => { if (!el.contains(e.relatedTarget)) el.classList.remove('drag'); });
    el.addEventListener('drop', (e) => {
      e.preventDefault();
      e.stopPropagation();
      el.classList.remove('drag');
      hideMask();
      if (e.dataTransfer.files.length) this.sendFiles(e.dataTransfer.files);
    });
    $('#peers').appendChild(el);
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
    let cls = '', txt = '', frac = 0, busy = false;
    const t = this.out, inc = this.inc;
    if (t) {
      busy = true;
      cls = 'run';
      if (t.phase === 'link') txt = '正在建立连接…';
      else if (t.phase === 'wait') txt = '等待对方接收…';
      else if (t.phase === 'finish') { txt = '等待对方保存…'; frac = 1; }
      else {
        frac = t.total ? t.sent / t.total : 1;
        const secs = (performance.now() - t.start) / 1000;
        txt = `发送中 ${Math.floor(frac * 100)}%` + (secs > 0.5 ? ` · ${fmtSize(t.sent / secs)}/s` : '');
      }
    } else if (inc) {
      busy = true;
      cls = 'run';
      frac = inc.total ? inc.got / inc.total : 0;
      const secs = (performance.now() - inc.start) / 1000;
      txt = `接收中 ${Math.floor(frac * 100)}%` + (secs > 0.5 ? ` · ${fmtSize(inc.got / secs)}/s` : '');
    } else if (this.p2p) { cls = 'ok'; txt = '直连就绪'; }
    else if (Date.now() - this.connectStarted < P2P_WAIT && !(this.pc && this.pc.connectionState === 'failed')) { txt = '正在直连…'; }
    else if (relayAllowed) { cls = 'warn'; txt = '经服务器中转'; }
    else { cls = 'warn'; txt = '无法直连'; }
    const st = $('.peer-state', el);
    st.className = 'peer-state ' + cls;
    st.lastElementChild.textContent = txt;
    el.classList.toggle('busy', busy);
    $('.ring .bar', el).style.strokeDashoffset = String(257.6 * (1 - Math.min(1, frac)));
    const acts = busy
      ? `<button class="btn btn-sm" data-act="cancel">取消</button>`
      : `<button class="btn btn-primary btn-sm" data-act="file">发送文件</button><button class="btn btn-sm" data-act="text">发文字</button>`;
    const box = $('.peer-actions', el);
    if (box.dataset.busy !== String(busy)) { box.innerHTML = acts; box.dataset.busy = String(busy); }
  }
  destroy(reason) {
    if (this.out) { this.out.cancelled = true; this.out.cancelReason = reason; this.reply(this.out.tid, 'cancel'); this.out.wake?.(); }
    for (const tid of [...this.waiters.keys()]) this.reply(tid, 'cancel');
    if (this.inc) toast(`${this.name}：${reason}，接收中断`, 'error');
    if (this.pendingReq) this.pendingReq.close();
    this.queue.length = 0;
    this.resetPC();
    this.el?.remove();
    this.el = null;
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
    el.innerHTML = `<div class="item-ico">${icon('file', 17)}</div><div class="item-main">
      <div class="item-title" title="${esc(it.name)}">${esc(it.name)}</div>
      <div class="item-meta">${fmtSize(it.size)} · ${who} · ${fmtTime()}${via}</div>
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
function pickFiles(peer) {
  pickTarget = peer;
  const inp = $('#filePick');
  inp.value = '';
  inp.click();
}
$('#filePick').onchange = (e) => {
  if (pickTarget && peers.get(pickTarget.id) === pickTarget) pickTarget.sendFiles(e.target.files);
  pickTarget = null;
};

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

const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
const onlyPeer = () => (peers.size === 1 ? [...peers.values()][0] : null);

// 整页拖拽：只有一台设备时，拖到任意位置即发送
let maskTimer = null;
function hideMask() { $('#dropMask').hidden = true; }
document.addEventListener('dragover', (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  const p = onlyPeer();
  e.dataTransfer.dropEffect = p ? 'copy' : 'none';
  if (p || peers.size === 0) {
    $('#dropText').textContent = p ? `松开即可发送给 ${p.name}` : '还没有发现其他设备';
    $('#dropMask').hidden = false;
  }
  clearTimeout(maskTimer);
  maskTimer = setTimeout(hideMask, 150);
});
document.addEventListener('drop', (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  hideMask();
  const p = onlyPeer();
  if (p && e.dataTransfer.files.length) p.sendFiles(e.dataTransfer.files);
  else if (peers.size > 1) toast('有多台设备，请把文件拖到具体的设备上');
});

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
