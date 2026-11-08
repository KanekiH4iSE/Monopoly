'use strict';
/* Магнат — сервер: раздаёт страницу, держит комнаты и ведёт игру (вся логика здесь, клиенты только рисуют) */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const MAG = require('./public/data.js');
const { BOARD, GROUPS, GROUP_IDX, CHANCE, CHEST } = MAG;

const PORT = process.env.PORT || 3000;
const PUB = path.join(__dirname, 'public');
const MAX_ROOMS = 300;
const FAST = process.env.FAST ? 0.02 : 1; // только для автотестов
const TURN_MS = 90000;

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const rnd = n => crypto.randomInt(n);
const shuffle = a => { for (let i = a.length - 1; i > 0; i--) { const j = rnd(i + 1); [a[i], a[j]] = [a[j], a[i]]; } return a; };
const send = (ws, o) => { if (ws && ws.readyState === 1) ws.send(JSON.stringify(o)); };
const cleanName = s => String(s || '').replace(/[\u0000-\u001f<>&"]/g, '').trim().slice(0, 14);
const BOT_NAMES = ['Алиса', 'Борис', 'Вера', 'Глеб', 'Дина', 'Егор', 'Жанна', 'Захар', 'Ира', 'Кирилл'];

/* ======================= HTTP ======================= */
const server = http.createServer((req, res) => {
  let p;
  try { p = decodeURIComponent(new URL(req.url, 'http://x').pathname); } catch { res.writeHead(400); return res.end(); }
  if (p === '/healthz') { res.writeHead(200); return res.end('ok'); }
  if (p === '/') p = '/index.html';
  const f = path.normalize(path.join(PUB, p));
  if (!f.startsWith(PUB + path.sep)) { res.writeHead(403); return res.end(); }
  fs.readFile(f, (e, b) => {
    if (e) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(b);
  });
});

/* ======================= Комнаты ======================= */
const rooms = new Map();
function newCode() {
  const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  let c;
  do { c = Array.from({ length: 5 }, () => A[rnd(A.length)]).join(''); } while (rooms.has(c));
  return c;
}

class Room {
  constructor(code) {
    this.code = code; this.players = []; this.state = 'lobby'; this.cash = 1500;
    this.game = null; this.hostP = null; this.idle = Date.now(); this.video = null; this.vidAt = 0;
    this.chat = []; this.chatAt = new Map(); this.opts = { auction: true, jackpot: false };
  }
  broadcast(o) {
    const s = JSON.stringify(o);
    for (const p of this.players) if (!p.bot && p.connected && p.ws && p.ws.readyState === 1) p.ws.send(s);
  }
  pushRoom() {
    const host = this.players.indexOf(this.hostP);
    const list = this.players.map(q => ({ name: q.name, emoji: q.emoji, color: q.color, bot: q.bot, connected: q.bot ? true : q.connected }));
    this.players.forEach((p, i) => {
      if (p.bot || !p.connected) return;
      send(p.ws, { t: 'room', code: this.code, state: this.state, cash: this.cash, host, you: i, players: list, video: this.video, opts: this.opts });
    });
  }
  freeToken() {
    const ue = new Set(this.players.map(p => p.emoji)), uc = new Set(this.players.map(p => p.color));
    for (let i = 0; i < MAG.TOKENS.length; i++) if (!ue.has(MAG.TOKENS[i][0]) && !uc.has(MAG.TOKENS[i][1])) return i;
    for (let i = 0; i < MAG.EMOJIS.length; i++) if (!ue.has(MAG.EMOJIS[i])) return -i - 1;
    return 0;
  }
  add(name, ws, bot) {
    const ti = this.freeToken();
    let emoji, color;
    if (ti >= 0) [emoji, color] = MAG.TOKENS[ti];
    else { emoji = MAG.EMOJIS[-ti - 1]; color = MAG.COLORS.find(c => !this.players.some(q => q.color === c)) || '#888888'; }
    const p = { name, emoji, color, bot: !!bot, ws: bot ? null : ws, connected: !bot, uid: crypto.randomBytes(4).toString('hex'), secret: bot ? null : crypto.randomBytes(12).toString('hex') };
    this.players.push(p);
    if (!this.hostP && !bot) this.hostP = p;
    return p;
  }
  remove(p) {
    const i = this.players.indexOf(p);
    if (i < 0) return;
    this.players.splice(i, 1);
    if (this.hostP === p) this.hostP = this.players.find(q => !q.bot) || null;
    if (!this.hostP) this.destroy();
  }
  destroy() {
    if (this.game) this.game.destroy();
    rooms.delete(this.code);
  }
}

function detachWs(ws) {
  const ctx = ws.ctx;
  ws.ctx = null;
  if (!ctx) return;
  const { room, player } = ctx;
  if (player.ws !== ws) return;
  player.connected = false; player.ws = null;
  if (room.state === 'lobby') {
    setTimeout(() => { if (!player.connected && room.players.includes(player) && room.state === 'lobby') { room.remove(player); if (rooms.has(room.code)) room.pushRoom(); } }, 20000);
    room.pushRoom();
  } else if (room.game) {
    room.game.onDisconnect(room.players.indexOf(player));
    room.game.sync();
  }
}

function attach(ws, room, player) {
  if (player.ws && player.ws !== ws) { player.ws.ctx = null; try { player.ws.close(); } catch {} }
  player.ws = ws; player.connected = true;
  ws.ctx = { room, player };
  send(ws, { t: 'session', code: room.code, secret: player.secret, uid: player.uid });
  send(ws, { t: 'chatlog', msgs: room.chat });
}

function onMsg(ws, raw) {
  let m;
  try { m = JSON.parse(raw); } catch { return; }
  if (!m || typeof m.t !== 'string') return;
  if (m.t === 'ping') return;

  if (m.t === 'create') {
    if (ws.ctx) detachWs(ws);
    if (rooms.size >= MAX_ROOMS) return send(ws, { t: 'err', msg: 'Сервер переполнен, попробуй позже.' });
    const room = new Room(newCode());
    rooms.set(room.code, room);
    const p = room.add(cleanName(m.name) || 'Игрок', ws, false);
    attach(ws, room, p); room.pushRoom();
    return;
  }
  if (m.t === 'join') {
    const room = rooms.get(String(m.code || '').toUpperCase().trim());
    if (!room) return send(ws, { t: 'err', msg: 'Комната с таким кодом не найдена.' });
    if (room.state !== 'lobby') return send(ws, { t: 'err', msg: 'Игра в этой комнате уже идёт.' });
    if (room.players.length >= 10) return send(ws, { t: 'err', msg: 'В комнате уже 10 игроков.' });
    if (ws.ctx) detachWs(ws);
    const p = room.add(cleanName(m.name) || 'Игрок', ws, false);
    attach(ws, room, p); room.pushRoom();
    return;
  }
  if (m.t === 'rejoin') {
    const room = rooms.get(String(m.code || '').toUpperCase());
    const p = room && room.players.find(q => !q.bot && q.secret && q.secret === m.secret);
    if (!p) return send(ws, { t: 'norejoin' });
    attach(ws, room, p); room.idle = Date.now();
    room.pushRoom();
    if (room.game) room.game.onReconnect(room.players.indexOf(p));
    return;
  }

  const ctx = ws.ctx;
  if (!ctx) return;
  const { room, player } = ctx;
  room.idle = Date.now();
  const seat = room.players.indexOf(player);
  const isHost = room.hostP === player;

  if (m.t === 'leave') {
    ws.ctx = null; player.connected = false; player.ws = null;
    if (room.state === 'lobby') { room.remove(player); if (rooms.has(room.code)) room.pushRoom(); }
    else if (room.game) { player.bot = true; room.game.makeBot(seat); room.game.onDisconnect(seat); if (room.hostP === player) room.hostP = room.players.find(q => !q.bot && q.connected) || null; room.pushRoom(); room.game.sync(); if (!room.players.some(q => !q.bot && q.connected)) room.destroy(); }
    return;
  }

  if (m.t === 'chat') {
    const now = Date.now();
    if (now - (room.chatAt.get(player) || 0) < 700) return;
    room.chatAt.set(player, now);
    const text = String(m.text || '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, 200);
    if (!text) return;
    const msg = { uid: player.uid, name: player.name, emoji: player.emoji, color: player.color, text, ts: now };
    room.chat.push(msg); if (room.chat.length > 60) room.chat.shift();
    room.broadcast({ t: 'chat', msg });
    return;
  }

  if (m.t === 'video') {
    const now = Date.now();
    if (now - room.vidAt < 600) return;
    room.vidAt = now;
    const v = m.video;
    let nv = null;
    if (v && typeof v === 'object') {
      const id = String(v.id);
      if (v.kind === 'v' && /^[\w-]{11}$/.test(id)) nv = { kind: 'v', id };
      else if (v.kind === 'p' && /^[\w-]{10,60}$/.test(id)) nv = { kind: 'p', id };
      else return;
    }
    room.video = nv;
    room.broadcast({ t: 'video', video: nv, by: player.name });
    return;
  }

  if (room.state === 'lobby') {
    if (m.t === 'style') {
      const i = Number.isInteger(m.seat) ? m.seat : seat;
      const target = room.players[i];
      if (!target || (i !== seat && !isHost)) return;
      const emoji = String(m.emoji || target.emoji), color = String(m.color || target.color).toLowerCase();
      if (!MAG.EMOJIS.includes(emoji) || !/^#[0-9a-f]{6}$/.test(color)) return;
      if (room.players.some((q, j) => j !== i && (q.emoji === emoji || q.color === color))) return send(ws, { t: 'toast', msg: 'Этот смайл или цвет уже занят другим игроком.' });
      target.emoji = emoji; target.color = color; room.pushRoom();
    } else if (m.t === 'name') {
      const n = cleanName(m.name);
      if (n) { player.name = n; room.pushRoom(); }
    } else if (m.t === 'opts' && isHost) {
      room.opts = { auction: !!m.auction, jackpot: !!m.jackpot }; room.pushRoom();
    } else if (m.t === 'addbot' && isHost && room.players.length < 10) {
      const used = new Set(room.players.map(q => q.name));
      const nm = BOT_NAMES.map(n => 'Бот ' + n).find(n => !used.has(n)) || 'Бот ' + (room.players.length + 1);
      room.add(nm, null, true); room.pushRoom();
    } else if (m.t === 'remove' && isHost && Number.isInteger(m.seat) && m.seat !== seat) {
      const q = room.players[m.seat];
      if (!q) return;
      if (!q.bot && q.ws) { send(q.ws, { t: 'kicked' }); q.ws.ctx = null; }
      room.players.splice(m.seat, 1); room.pushRoom();
    } else if (m.t === 'cash' && isHost && [1000, 1500, 2000, 3000].includes(m.cash)) {
      room.cash = m.cash; room.pushRoom();
    } else if (m.t === 'start' && isHost && room.players.length >= 2) {
      room.state = 'playing';
      room.game = createGame(room);
      room.pushRoom(); room.game.sync(); room.game.run();
    }
    return;
  }

  if (m.t === 'again' && isHost && room.state === 'over') {
    if (room.game) room.game.destroy();
    room.game = null; room.state = 'lobby';
    room.players = room.players.filter(q => q.bot || q.connected);
    room.pushRoom();
    return;
  }
  if (!room.game) return;
  const g = room.game;
  if (m.t === 'act') g.act(seat, m.id, m.choice, m.data);
  else if (m.t === 'manage') g.manageAction(seat, m.a, m.i);
  else if (m.t === 'debtDone') g.debtDone(seat, !!m.bankrupt);
  else if (m.t === 'tradeReply') g.tradeReply(seat, m.id, !!m.ok);
  else if (m.t === 'bid') g.bid(seat, m.amount);
  else if (m.t === 'pass') g.passAuction(seat);
}

/* ======================= Игровой движок ======================= */
const CANCEL = Symbol('cancel');

function createGame(room) {
  let dead = false, seq = 0, lastData = null;
  const G = {
    players: room.players.map((rp, i) => ({
      id: i, name: rp.name, emoji: rp.emoji, color: rp.color, bot: rp.bot, cash: room.cash, pos: 0, inJail: false, jailTries: 0,
      jf: [], bankrupt: false, tradeCd: 0, triedTrade: false
    })),
    turn: 0, doubles: 0, owner: Array(40).fill(null), houses: Array(40).fill(0), mort: Array(40).fill(false),
    decks: { chance: shuffle(CHANCE.slice()), chest: shuffle(CHEST.slice()) },
    over: false, lastSum: 7, waiting: null, offer: null, auction: null, pot: 0,
    order: room.players.map((_, i) => i)
  };

  const sleep = ms => new Promise((res, rej) => setTimeout(() => (dead ? rej(CANCEL) : res()), ms * FAST));
  const ev = (k, o = {}) => room.broadcast(Object.assign({ t: 'ev', k }, o));
  const log = (p, msg) => ev('log', { pid: p ? p.id : null, msg: (p ? `<b>${esc(p.name)}</b> ` : '') + msg });
  const banner = text => ev('banner', { text });
  const snd = s => ev('sound', { s });
  const money = n => '$' + Math.round(n).toLocaleString('ru-RU');
  const online = p => !p.bot && room.players[p.id] && room.players[p.id].connected;
  const ownedBy = p => BOARD.map((_, i) => i).filter(i => G.owner[i] === p.id);

  function snapshot() {
    const w = G.waiting;
    return {
      turn: G.turn, order: G.order, pot: G.pot, opts: room.opts, over: G.over, owner: G.owner, houses: G.houses, mort: G.mort,
      waiting: w ? { seat: w.seat, phase: w.phase, id: w.id, deadline: w.deadline, left: Math.max(0, w.deadline - Date.now()), info: w.info == null ? null : w.info, amt: w.amt || 0 } : null,
      auction: G.auction ? { tile: G.auction.tile, bid: G.auction.bid, leader: G.auction.leader, passed: G.auction.passed, deadline: G.auction.deadline, left: Math.max(0, G.auction.deadline - Date.now()) } : null,
      players: G.players.map((p, i) => ({
        id: i, name: p.name, emoji: p.emoji, color: p.color, bot: p.bot, connected: p.bot ? true : !!(room.players[i] && room.players[i].connected),
        cash: p.cash, pos: p.pos, inJail: p.inJail, jf: p.jf.length, bankrupt: p.bankrupt
      }))
    };
  }
  const sync = () => room.broadcast({ t: 'state', s: snapshot() });

  /* ---------- деньги ---------- */
  function addCash(p, d) { p.cash += d; ev('cash', { pid: p.id, d }); sync(); }
  const netWorth = p => p.cash + ownedBy(p).reduce((s, i) => s + BOARD[i].price + (BOARD[i].type === 'street' ? G.houses[i] * GROUPS[BOARD[i].grp].house : 0), 0);
  const pop = i => ev('pop', { i });

  async function payMoney(p, amt, to) {
    if (amt <= 0) return true;
    if (p.cash < amt) {
      if (!online(p)) botLiquidate(p, amt);
      else {
        banner(`${p.name}: нужно ${money(amt)}, собирает деньги`);
        const r = await humanDebt(p, amt);
        if (r === 'bankrupt') { await goBankrupt(p, to); return false; }
      }
    }
    if (p.cash < amt) { await goBankrupt(p, to); return false; }
    addCash(p, -amt); snd('pay');
    if (to) { addCash(to, amt); snd('coin'); }
    return true;
  }
  async function goBankrupt(p, to) {
    log(p, `<b>банкрот!</b> ${to ? 'Всё имущество переходит к ' + esc(to.name) : 'Имущество возвращается банку'}`);
    banner(p.name + ' — банкрот 💀'); snd('bankrupt');
    if (to && p.cash > 0) addCash(to, p.cash);
    ownedBy(p).forEach(i => { G.houses[i] = 0; if (to) G.owner[i] = to.id; else { G.owner[i] = null; G.mort[i] = false; } pop(i); });
    p.jf.forEach(x => { if (to) to.jf.push(x); else G.decks[x.deck].push(x.card); });
    p.jf = []; p.cash = 0; p.bankrupt = true;
    ev('bankrupt', { pid: p.id }); sync();
    await sleep(900);
    checkWin();
  }
  function checkWin() {
    const alive = G.players.filter(x => !x.bankrupt);
    if (alive.length === 1 && !G.over) {
      G.over = true; room.state = 'over';
      ev('win', { pid: alive[0].id, worth: netWorth(alive[0]) });
      room.pushRoom(); sync();
    }
  }

  /* ---------- кубики и движение ---------- */
  async function rollDice(p) {
    const a = 1 + rnd(6), b = 1 + rnd(6);
    ev('dice', { pid: p.id, a, b });
    await sleep(1050);
    G.lastSum = a + b;
    log(p, `бросает кубики: <b>${a}</b> + <b>${b}</b> = ${a + b}${a === b ? ' · дубль!' : ''}`);
    banner(`${p.name}: ${a} + ${b} = ${a + b}${a === b ? ' · дубль!' : ''}`);
    return [a, b];
  }
  async function moveSteps(p, n, dir = 1) {
    for (let k = 0; k < n; k++) {
      p.pos = (p.pos + dir + 40) % 40;
      if (dir === 1 && p.pos === 0) { addCash(p, 200); snd('coin'); log(p, 'проходит СТАРТ: <b>+$200</b>'); }
      sync(); ev('hop', { pid: p.id, pos: p.pos });
      await sleep(185);
    }
    ev('layout');
  }
  const moveTo = (p, target) => moveSteps(p, (target - p.pos + 40) % 40);
  async function sendToJail(p) {
    log(p, 'отправляется в <b>тюрьму</b> 🔒'); banner(p.name + ' — в тюрьму!');
    p.pos = 10; p.inJail = true; p.jailTries = 0; G.doubles = 0;
    sync(); ev('jail', { pid: p.id }); snd('jail');
    await sleep(700);
    ev('layout');
  }
  const moveAndLand = async (p, sum) => { await moveSteps(p, sum); await landOn(p, { sum }); };

  /* ---------- клетки ---------- */
  async function landOn(p, ctx = {}) {
    const t = BOARD[p.pos];
    if (['street', 'station', 'util'].includes(t.type)) await landProperty(p, p.pos, ctx);
    else if (t.type === 'tax') {
      log(p, `платит налог ${money(t.amount)}`); banner(`${p.name}: налог ${money(t.amount)}`);
      if (await payMoney(p, t.amount, null) && room.opts.jackpot) { G.pot += t.amount; sync(); }
    }
    else if (t.type === 'parking' && room.opts.jackpot && G.pot > 0) {
      const pot = G.pot; G.pot = 0;
      log(p, `забирает джекпот на парковке: <b>${money(pot)}</b>`); banner(`${p.name} срывает джекпот ${money(pot)}!`);
      addCash(p, pot); snd('coin');
    }
    else if (t.type === 'chance') await drawCard(p, 'chance');
    else if (t.type === 'chest') await drawCard(p, 'chest');
    else if (t.type === 'gojail') await sendToJail(p);
  }
  const ownsSet = (o, grp) => GROUP_IDX[grp].every(j => G.owner[j] === o);
  function calcRent(i, sum, ctx = {}) {
    const t = BOARD[i], o = G.owner[i];
    if (G.mort[i]) return 0;
    if (t.type === 'street') { const h = G.houses[i]; if (h > 0) return t.rent[h]; return ownsSet(o, t.grp) ? t.rent[0] * 2 : t.rent[0]; }
    if (t.type === 'station') { const n = GROUP_IDX.station.filter(j => G.owner[j] === o).length; return 25 * Math.pow(2, n - 1) * (ctx.mult || 1); }
    const n = GROUP_IDX.util.filter(j => G.owner[j] === o).length;
    return sum * ((ctx.utilTen || n >= 2) ? 10 : 4);
  }
  async function landProperty(p, i, ctx) {
    const t = BOARD[i], o = G.owner[i];
    if (o === null) {
      log(p, `встал на <b>${t.name}</b> (${money(t.price)})`);
      const a = await ask(p, [
        { id: 'buy', label: `🏷 Купить за ${money(t.price)}`, cls: 'primary' },
        { id: 'skip', label: 'Отказаться' }
      ], 'buy', i);
      if (a === 'buy' && p.cash >= t.price) buyProp(p, i);
      else if (room.opts.auction) { log(p, 'отказался от покупки — <b>аукцион</b>!'); await runAuction(i); }
      else log(p, 'отказался от покупки');
    } else if (o !== p.id) {
      const owner = G.players[o];
      if (G.mort[i]) { log(p, `<b>${t.name}</b> в залоге — аренды нет`); banner('Клетка в залоге — аренды нет'); return; }
      let sum = ctx.sum || G.lastSum;
      if (t.type === 'util' && ctx.utilTen) { const d = await rollDice(p); sum = d[0] + d[1]; }
      const rent = calcRent(i, sum, ctx);
      log(p, `платит аренду <b>${money(rent)}</b> → ${esc(owner.name)} (${t.name})`);
      banner(`${p.name} платит ${money(rent)} → ${owner.name}`);
      await payMoney(p, rent, owner);
    }
  }
  function buyProp(p, i) {
    addCash(p, -BOARD[i].price); G.owner[i] = p.id; pop(i); sync(); snd('buy');
    log(p, `покупает <b>${BOARD[i].name}</b> за ${money(BOARD[i].price)}`); banner(`${p.name} покупает ${BOARD[i].name}`);
  }

  /* ---------- карты ---------- */
  async function drawCard(p, deck) {
    const d = G.decks[deck], card = d.shift();
    log(p, `тянет карту «${deck === 'chance' ? 'Шанс' : 'Сюрприз'}»`);
    ev('card', { pid: p.id, deck, text: card.text }); snd('card');
    await sleep(3300);
    log(null, `<i>${card.text}</i>`);
    if (card.t !== 'jf') d.push(card);
    await applyCard(p, card, deck);
  }
  async function applyCard(p, c, deck) {
    const others = () => G.players.filter(x => !x.bankrupt && x.id !== p.id);
    switch (c.t) {
      case 'goto': await moveTo(p, c.to); await landOn(p, { sum: G.lastSum }); break;
      case 'gain': addCash(p, c.n); snd('coin'); break;
      case 'loss': await payMoney(p, c.n, null); break;
      case 'jf': p.jf.push({ deck, card: c }); sync(); break;
      case 'jail': await sendToJail(p); break;
      case 'back': await moveSteps(p, c.n, -1); await landOn(p, { sum: G.lastSum }); break;
      case 'near': {
        let i = p.pos; do { i = (i + 1) % 40; } while (BOARD[i].type !== c.k);
        await moveTo(p, i); await landOn(p, { sum: G.lastSum, mult: c.k === 'station' ? 2 : 1, utilTen: c.k === 'util' }); break;
      }
      case 'repair': {
        let cost = 0; ownedBy(p).forEach(i => { const h = G.houses[i]; cost += h === 5 ? c.H : h * c.h; });
        log(p, `ремонт обходится в ${money(cost)}`); await payMoney(p, cost, null); break;
      }
      case 'payeach': for (const o of others()) { if (p.bankrupt) break; await payMoney(p, c.n, o); } break;
      case 'getall': for (const o of others()) { if (G.over) break; await payMoney(o, c.n, p); } break;
    }
  }

  /* ---------- имущество ---------- */
  function canBuild(p, i) {
    const t = BOARD[i]; if (t.type !== 'street' || G.owner[i] !== p.id) return false;
    const g = GROUP_IDX[t.grp]; if (!g.every(j => G.owner[j] === p.id && !G.mort[j])) return false;
    if (G.houses[i] >= 5) return false;
    if (G.houses[i] > Math.min(...g.map(j => G.houses[j]))) return false;
    return p.cash >= GROUPS[t.grp].house;
  }
  function canSell(p, i) {
    const t = BOARD[i]; if (t.type !== 'street' || G.owner[i] !== p.id || G.houses[i] < 1) return false;
    return G.houses[i] === Math.max(...GROUP_IDX[t.grp].map(j => G.houses[j]));
  }
  function canMortgage(p, i) {
    const t = BOARD[i]; if (G.owner[i] !== p.id || G.mort[i]) return false;
    if (t.type === 'street') return GROUP_IDX[t.grp].every(j => G.houses[j] === 0);
    return true;
  }
  const unmortCost = i => Math.ceil(BOARD[i].price / 2 * 1.1);
  const canUnmortgage = (p, i) => G.owner[i] === p.id && G.mort[i] && p.cash >= unmortCost(i);
  function build(p, i) { addCash(p, -GROUPS[BOARD[i].grp].house); G.houses[i]++; pop(i); sync(); snd('build'); log(p, `строит ${G.houses[i] === 5 ? '<b>отель</b>' : 'дом'} на «${BOARD[i].name}»`); }
  function sell(p, i) { G.houses[i]--; addCash(p, GROUPS[BOARD[i].grp].house / 2); pop(i); sync(); log(p, `продаёт постройку на «${BOARD[i].name}»`); }
  function mortgage(p, i) { G.mort[i] = true; addCash(p, BOARD[i].price / 2); pop(i); sync(); log(p, `закладывает «${BOARD[i].name}»`); }
  function unmortgage(p, i) { addCash(p, -unmortCost(i)); G.mort[i] = false; pop(i); sync(); log(p, `выкупает «${BOARD[i].name}»`); }

  function manageAction(seat, a, i) {
    const w = G.waiting; if (!w || w.seat !== seat) return;
    const p = G.players[seat]; i = Number(i);
    if (!Number.isInteger(i) || i < 0 || i > 39) return;
    if (a === 'b' && canBuild(p, i)) build(p, i);
    else if (a === 's' && canSell(p, i)) sell(p, i);
    else if (a === 'm' && canMortgage(p, i)) mortgage(p, i);
    else if (a === 'u' && canUnmortgage(p, i)) unmortgage(p, i);
  }

  /* ---------- обмен ---------- */
  const tradable = i => { const t = BOARD[i]; return t.type !== 'street' || GROUP_IDX[t.grp].every(j => G.houses[j] === 0); };
  function validTrade(p, d) {
    if (!d || typeof d !== 'object') return null;
    const o = G.players[Number(d.q)];
    if (!o || o.bankrupt || o.id === p.id) return null;
    const ints = a => (Array.isArray(a) ? [...new Set(a.map(Number))].filter(Number.isInteger) : null);
    const give = ints(d.give), get = ints(d.get);
    if (!give || !get) return null;
    const gc = Math.floor(Number(d.gc) || 0), rc = Math.floor(Number(d.rc) || 0);
    if (gc < 0 || rc < 0 || gc > p.cash || rc > o.cash) return null;
    if (!give.every(i => i >= 0 && i < 40 && G.owner[i] === p.id && tradable(i))) return null;
    if (!get.every(i => i >= 0 && i < 40 && G.owner[i] === o.id && tradable(i))) return null;
    if (!give.length && !get.length && !gc && !rc) return null;
    return { q: o.id, give, get, gc, rc };
  }
  const tradeLine = (list, cash) => { const a = list.map(i => BOARD[i].name); if (cash) a.push(money(cash)); return a.length ? a.join(', ') : 'ничего'; };
  function offerTrade(p, o, a) {
    return new Promise(res => {
      const id = ++seq;
      const close = ok => { clearTimeout(timer); G.offer = null; room.broadcast({ t: 'tradeOffer', id, close: true }); res(ok); };
      const timer = setTimeout(() => close(false), 45000);
      G.offer = { id, to: o.id, close };
      room.broadcast({ t: 'tradeOffer', id, from: p.id, to: o.id, give: a.give, get: a.get, gc: a.gc, rc: a.rc });
    });
  }
  function tradeReply(seat, id, ok) { if (G.offer && G.offer.id === id && G.offer.to === seat) G.offer.close(ok); }
  async function proposeTrade(p, data) {
    const a = validTrade(p, data);
    if (!a) { banner('Такой обмен невозможен'); return; }
    const o = G.players[a.q];
    log(p, `предлагает обмен игроку <b>${esc(o.name)}</b>${a.gc ? ' и платит ' + money(a.gc) : ''}`);
    let ok;
    if (!online(o)) { banner(`${o.name} обдумывает обмен…`); await sleep(1000); ok = botEvalTrade(o, p, a); }
    else { banner(`${o.name} отвечает на предложение обмена…`); ok = await offerTrade(p, o, a); }
    if (ok && validTrade(p, a)) execTrade(p, o, a);
    else { log(o, 'отказывается от обмена'); banner('Обмен отклонён'); }
  }
  function execTrade(p, o, a) {
    a.give.forEach(i => { G.owner[i] = o.id; pop(i); });
    a.get.forEach(i => { G.owner[i] = p.id; pop(i); });
    const net = a.rc - a.gc;
    if (net) addCash(p, net);
    if (-net) addCash(o, -net);
    sync(); snd('buy');
    log(null, `🤝 <b>${esc(p.name)}</b> ⇄ <b>${esc(o.name)}</b>: ${esc(tradeLine(a.give, a.gc))} ⇄ ${esc(tradeLine(a.get, a.rc))}`);
    banner('Обмен состоялся!');
  }
  function botEvalTrade(bot, from, a) {
    const val = i => BOARD[i].price * (G.mort[i] ? .55 : 1);
    const recv = a.give.reduce((s, i) => s + val(i), 0) + a.gc, lose = a.get.reduce((s, i) => s + val(i), 0) + a.rc;
    let bonus = 0;
    for (const g in GROUP_IDX) {
      if (!GROUPS[g].house) continue;
      const idx = GROUP_IDX[g], gv = idx.reduce((s, j) => s + BOARD[j].price, 0) * .6;
      const bb = idx.every(j => G.owner[j] === bot.id), ba = idx.every(j => (G.owner[j] === bot.id && !a.get.includes(j)) || a.give.includes(j));
      const fb = idx.every(j => G.owner[j] === from.id), fa = idx.every(j => (G.owner[j] === from.id && !a.give.includes(j)) || a.get.includes(j));
      bonus += gv * ((ba ? 1 : 0) - (bb ? 1 : 0)) - gv * ((fa ? 1 : 0) - (fb ? 1 : 0));
    }
    return recv + bonus >= lose * 1.1 && bot.cash - a.rc + a.gc >= 0;
  }

  /* ---------- боты ---------- */
  function botTradeIdea(p) {
    for (const g of Object.keys(GROUPS)) {
      if (!GROUPS[g].house) continue;
      const idx = GROUP_IDX[g], mine = idx.filter(j => G.owner[j] === p.id), miss = idx.filter(j => G.owner[j] !== p.id);
      if (miss.length !== 1 || !mine.length) continue;
      const j = miss[0], o = G.owner[j];
      if (o === null || !tradable(j)) continue;
      const gv = idx.reduce((s, k) => s + BOARD[k].price, 0) * .6;
      const offer = Math.ceil((BOARD[j].price * (G.mort[j] ? .55 : 1) * 1.1 + gv) * 1.05 / 10) * 10;
      if (p.cash - offer < 150) continue;
      return { q: o, give: [], get: [j], gc: offer, rc: 0 };
    }
    return null;
  }
  function botWantsBuy(p, i) {
    const t = BOARD[i]; if (p.cash < t.price) return false;
    let need = 150;
    if (t.type === 'street' && GROUP_IDX[t.grp].filter(j => j !== i).every(j => G.owner[j] === p.id)) need = 0;
    else if (t.type === 'street' && GROUP_IDX[t.grp].some(j => G.owner[j] !== null && G.owner[j] !== p.id)) need = 250;
    else if (t.type === 'station') need = 100;
    return p.cash - t.price >= need;
  }
  function botManage(p) {
    for (const i of ownedBy(p)) if (G.mort[i] && p.cash >= unmortCost(i) + 500) unmortgage(p, i);
    let guard = 40;
    while (guard--) {
      const c = ownedBy(p).filter(i => canBuild(p, i) && p.cash - GROUPS[BOARD[i].grp].house >= 250);
      if (!c.length) break;
      c.sort((a, b) => BOARD[b].price - BOARD[a].price); build(p, c[0]);
    }
  }
  function botLiquidate(p, need) {
    let guard = 200;
    while (p.cash < need && guard--) {
      const hs = ownedBy(p).filter(i => canSell(p, i)); if (hs.length) { sell(p, hs[0]); continue; }
      const ms = ownedBy(p).filter(i => canMortgage(p, i)); if (ms.length) { mortgage(p, ms[0]); continue; }
      break;
    }
  }
  async function botAsk(p, opts, phase, info) {
    await sleep(700);
    if (phase === 'buy') return botWantsBuy(p, info) ? 'buy' : 'skip';
    if (phase === 'pre') {
      botManage(p);
      if (p.inJail) {
        if (p.jf.length && opts.some(o => o.id === 'card')) return 'card';
        if (p.cash >= 400 && opts.some(o => o.id === 'pay')) return 'pay';
      }
      return 'roll';
    }
    if (phase === 'post') { botManage(p); return 'end'; }
    return opts[0].id;
  }

  /* ---------- запросы к игрокам ---------- */
  function finish(choice, data) {
    const w = G.waiting; if (!w) return;
    clearTimeout(w.timer); G.waiting = null; lastData = data;
    room.broadcast({ t: 'prompt', seat: -1 });
    sync(); w.resolve(choice);
  }
  function ask(p, opts, phase, info) {
    if (!online(p)) return botAsk(p, opts, phase, info);
    return new Promise(res => {
      const id = ++seq, deadline = Date.now() + TURN_MS;
      G.waiting = { seat: p.id, phase, id, opts, info, deadline, resolve: res, timer: null };
      G.waiting.timer = setTimeout(async () => {
        if (!G.waiting || G.waiting.id !== id) return;
        try { const c = await botAsk(p, opts, phase, info); if (G.waiting && G.waiting.id === id) finish(c, null); } catch (e) { if (e !== CANCEL) console.error(e); }
      }, TURN_MS);
      room.broadcast({ t: 'prompt', id, seat: p.id, phase, opts, info: info == null ? null : info, deadline });
      sync();
    });
  }
  function humanDebt(p, amt) {
    return new Promise(res => {
      const id = ++seq, deadline = Date.now() + TURN_MS;
      G.waiting = { seat: p.id, phase: 'debt', id, amt, deadline, resolve: res, timer: null };
      G.waiting.timer = setTimeout(() => {
        if (!G.waiting || G.waiting.id !== id) return;
        botLiquidate(p, amt); room.broadcast({ t: 'debtEnd' }); finish('ok');
      }, TURN_MS);
      room.broadcast({ t: 'debt', seat: p.id, amt, deadline });
      sync();
    });
  }
  function act(seat, id, choice, data) {
    const w = G.waiting;
    if (!w || w.seat !== seat || w.id !== id || w.phase === 'debt' || typeof choice !== 'string') return;
    const p = G.players[seat];
    if (choice === 'trade') { if (w.phase !== 'pre' && w.phase !== 'post') return; return finish('trade', data); }
    if (!w.opts.some(o => o.id === choice)) return;
    if (choice === 'buy' && p.cash < BOARD[w.info].price) return;
    if (choice === 'pay' && p.cash < 50) return;
    finish(choice, null);
  }
  function debtDone(seat, bankrupt) {
    const w = G.waiting;
    if (!w || w.seat !== seat || w.phase !== 'debt') return;
    if (bankrupt) return finish('bankrupt');
    if (G.players[seat].cash >= w.amt) finish('ok');
  }
  function onDisconnect(seat) {
    const p = G.players[seat]; if (!p) return;
    const w = G.waiting;
    if (w && w.seat === seat) {
      const id = w.id;
      (async () => {
        try {
          if (w.phase === 'debt') { botLiquidate(p, w.amt); room.broadcast({ t: 'debtEnd' }); if (G.waiting && G.waiting.id === id) finish('ok'); }
          else { const c = await botAsk(p, w.opts, w.phase, w.info); if (G.waiting && G.waiting.id === id) finish(c, null); }
        } catch (e) { if (e !== CANCEL) console.error(e); }
      })();
    }
    if (G.offer && G.offer.to === seat) G.offer.close(false);
    if (G.auction) G.auction.api.pass(seat);
  }
  function onReconnect(seat) {
    sync();
    const w = G.waiting;
    if (w && w.seat === seat) {
      if (w.phase === 'debt') send(room.players[seat].ws, { t: 'debt', seat, amt: w.amt, deadline: w.deadline });
      else send(room.players[seat].ws, { t: 'prompt', id: w.id, seat, phase: w.phase, opts: w.opts, info: w.info == null ? null : w.info, deadline: w.deadline });
    }
  }
  function makeBot(seat) { if (G.players[seat]) G.players[seat].bot = true; }

  /* ---------- ход ---------- */
  async function playerTurn(p) {
    G.doubles = 0; p.triedTrade = false;
    let again = true;
    while (again && !p.bankrupt && !G.over) {
      again = false;
      for (;;) {
        const opts = [];
        if (p.inJail && p.cash >= 50) opts.push({ id: 'pay', label: '💰 Выйти за $50' });
        if (p.inJail && p.jf.length) opts.push({ id: 'card', label: '🎟 Карта освобождения' });
        opts.push({ id: 'roll', label: G.doubles ? '🎲 Бросить ещё раз (дубль!)' : '🎲 Бросить кубики', cls: 'primary' });
        if (!online(p) && !p.triedTrade) {
          p.triedTrade = true;
          if (p.tradeCd > 0) p.tradeCd--;
          else { p.tradeCd = 3; const idea = botTradeIdea(p); if (idea) await proposeTrade(p, idea); }
        }
        const a = await ask(p, opts, 'pre');
        if (a === 'trade') { await proposeTrade(p, lastData); continue; }
        if (a === 'pay') { if (!await payMoney(p, 50, null)) return; p.inJail = false; p.jailTries = 0; log(p, 'платит $50 и выходит из тюрьмы'); sync(); continue; }
        if (a === 'card') { const x = p.jf.pop(); G.decks[x.deck].push(x.card); p.inJail = false; p.jailTries = 0; log(p, 'использует карту освобождения'); sync(); continue; }
        break;
      }
      const [d1, d2] = await rollDice(p), dbl = d1 === d2, sum = d1 + d2;
      if (p.inJail) {
        if (dbl) { p.inJail = false; p.jailTries = 0; log(p, 'выбросил дубль и выходит на свободу'); sync(); await moveAndLand(p, sum); }
        else {
          p.jailTries++;
          if (p.jailTries >= 3) {
            log(p, 'третья попытка не удалась — платит $50 и выходит');
            if (await payMoney(p, 50, null)) { p.inJail = false; p.jailTries = 0; sync(); await moveAndLand(p, sum); }
          } else { log(p, `остаётся в тюрьме (попытка ${p.jailTries} из 3)`); banner(`${p.name} остаётся в тюрьме`); }
        }
      } else {
        if (dbl) G.doubles++; else G.doubles = 0;
        if (dbl && G.doubles >= 3) { log(p, 'три дубля подряд — в тюрьму!'); await sendToJail(p); }
        else { await moveAndLand(p, sum); if (dbl && !p.bankrupt && !p.inJail && !G.over) again = true; }
      }
    }
    if (!p.bankrupt && !G.over) {
      for (;;) {
        const a = await ask(p, [{ id: 'end', label: '✅ Закончить ход', cls: 'primary' }], 'post');
        if (a === 'trade') { await proposeTrade(p, lastData); continue; }
        break;
      }
    }
  }
  function nextTurn() {
    let k = G.order.indexOf(G.turn);
    do { k = (k + 1) % G.order.length; G.turn = G.order[k]; } while (G.players[G.turn].bankrupt);
  }
  async function rollOff(ids, round) {
    if (ids.length <= 1) return ids.slice();
    if (round > 8) return shuffle(ids.slice());
    const res = [];
    for (const id of ids) {
      const p = G.players[id];
      G.turn = id; sync();
      await ask(p, [{ id: 'roll', label: round > 1 ? '🎲 Бросить ещё раз (ничья)' : '🎲 Бросить на очередность', cls: 'primary' }], 'first');
      const [a, b] = await rollDice(p);
      res.push({ id, t: a + b });
      await sleep(500);
    }
    const groups = new Map();
    res.forEach(r => { if (!groups.has(r.t)) groups.set(r.t, []); groups.get(r.t).push(r.id); });
    const out = [];
    for (const t of [...groups.keys()].sort((x, y) => y - x)) {
      const g = groups.get(t);
      if (g.length > 1) {
        log(null, `🤝 Ничья на ${t}: ${g.map(i => esc(G.players[i].name)).join(', ')} бросают ещё раз`);
        banner('Ничья! Перебрасывают…'); await sleep(1200);
        out.push(...await rollOff(g, round + 1));
      } else out.push(g[0]);
    }
    return out;
  }
  async function decideOrder() {
    banner('Кто ходит первым? Каждый бросает кубики');
    log(null, '🎲 Определяем очередность: у кого сумма больше, тот ходит первым');
    await sleep(1800);
    const order = await rollOff(G.players.map(p => p.id), 1);
    G.order = order; G.turn = order[0];
    log(null, '📋 Порядок ходов: ' + order.map((id, k) => `${k + 1}. ${esc(G.players[id].name)}`).join(' · '));
    sync(); banner(`${G.players[order[0]].name} ходит первым!`);
    await sleep(2200);
  }

  /* ---------- аукцион ---------- */
  const AUC_FIRST = 22000, AUC_BID = 11000;
  const bidStep = b => (b < 100 ? 10 : b < 300 ? 20 : b < 800 ? 50 : 100);
  const aucActive = () => G.players.filter(p => !p.bankrupt && !G.auction.passed.includes(p.id));
  function botMax(p, i) {
    const t = BOARD[i];
    let v = t.price * (0.7 + Math.random() * 0.45);
    if (t.type === 'street') {
      const idx = GROUP_IDX[t.grp], others = idx.filter(j => j !== i);
      const mine = others.filter(j => G.owner[j] === p.id).length;
      if (mine === others.length) v *= 1.9; else if (mine > 0) v *= 1.25;
      const oo = others.map(j => G.owner[j]);
      if (!mine && oo.every(o => o !== null && o === oo[0] && o !== p.id)) v *= 1.5;
    }
    return Math.min(Math.floor(v / 10) * 10, p.cash - 60);
  }
  function runAuction(i) {
    return new Promise(resolve => {
      const t = BOARD[i];
      const A = { tile: i, bid: 0, leader: null, passed: [], deadline: 0, timer: null, botTimers: [], max: {} };
      G.auction = A;
      const arm = () => {
        clearTimeout(A.timer);
        const ms = (A.leader === null ? AUC_FIRST : AUC_BID) * FAST;
        A.deadline = Date.now() + ms;
        A.timer = setTimeout(() => end(), ms);
      };
      const end = () => {
        if (G.auction !== A || dead) return;
        clearTimeout(A.timer); A.botTimers.forEach(clearTimeout); G.auction = null;
        if (A.leader !== null) {
          const w = G.players[A.leader];
          addCash(w, -A.bid); G.owner[i] = w.id; pop(i); snd('buy');
          log(w, `выигрывает аукцион: <b>${t.name}</b> за ${money(A.bid)}`); banner(`${w.name} забирает ${t.name} за ${money(A.bid)}`);
        } else { log(null, `🔨 Аукцион: никто не купил <b>${t.name}</b>`); banner('Никто не купил, клетка остаётся свободной'); }
        sync(); resolve();
      };
      const check = () => {
        const act = aucActive();
        if ((A.leader !== null && act.length <= 1) || (A.leader === null && act.length === 0)) end();
      };
      A.api = {
        bid(seat, amount) {
          const p = G.players[seat];
          if (G.auction !== A || !p || p.bankrupt || A.passed.includes(seat) || A.leader === seat) return false;
          amount = Math.floor(Number(amount));
          if (!Number.isFinite(amount) || amount < A.bid + 10 || amount > p.cash) return false;
          A.bid = amount; A.leader = seat; arm();
          log(p, `ставит <b>${money(amount)}</b>`); snd('coin'); sync(); check();
          return true;
        },
        pass(seat) {
          const p = G.players[seat];
          if (G.auction !== A || !p || p.bankrupt || A.passed.includes(seat) || A.leader === seat) return false;
          A.passed.push(seat); log(p, 'пасует'); sync(); check();
          return true;
        }
      };
      const botStep = p => {
        if (G.auction !== A || dead || A.passed.includes(p.id)) return;
        if (A.leader !== p.id) {
          const nb = A.bid === 0 ? 10 : A.bid + bidStep(A.bid);
          if (nb <= Math.min(A.max[p.id], p.cash)) A.api.bid(p.id, nb);
          else { A.api.pass(p.id); return; }
        }
        A.botTimers.push(setTimeout(() => botStep(p), (700 + rnd(1800)) * FAST));
      };
      log(null, `🔨 Аукцион на <b>${t.name}</b>: ставки от $10`); banner(`Аукцион: ${t.name}`);
      arm(); sync();
      G.players.filter(p => !p.bankrupt && !online(p)).forEach(p => {
        A.max[p.id] = botMax(p, i);
        A.botTimers.push(setTimeout(() => botStep(p), (600 + rnd(1600)) * FAST));
      });
      check();
    });
  }
  const bid = (seat, amount) => { if (G.auction) G.auction.api.bid(seat, amount); };
  const passAuction = seat => { if (G.auction) G.auction.api.pass(seat); };
  async function run() {
    try {
      await decideOrder();
      while (!G.over) {
        const p = G.players[G.turn];
        if (p.bankrupt) { nextTurn(); continue; }
        sync(); banner(`Ход: ${p.name}`);
        await playerTurn(p);
        if (G.over) break;
        nextTurn();
      }
    } catch (e) { if (e !== CANCEL) console.error(e); }
  }
  function destroy() { dead = true; if (G.waiting) clearTimeout(G.waiting.timer); }

  return { G, sync, run, act, manageAction, debtDone, tradeReply, onDisconnect, onReconnect, makeBot, destroy, bid, passAuction };
}

/* ======================= WebSocket ======================= */
const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 16 * 1024 });
wss.on('connection', ws => {
  ws.isAlive = true; ws.ctx = null;
  ws.on('pong', () => { ws.isAlive = true; });
  ws.on('message', raw => { try { onMsg(ws, raw.toString()); } catch (e) { console.error('msg error', e); } });
  ws.on('close', () => detachWs(ws));
  ws.on('error', () => {});
});
setInterval(() => {
  wss.clients.forEach(ws => { if (!ws.isAlive) return ws.terminate(); ws.isAlive = false; try { ws.ping(); } catch {} });
  const now = Date.now();
  for (const room of rooms.values()) {
    if (!room.players.some(p => !p.bot && p.connected) && now - room.idle > 10 * 60 * 1000) room.destroy();
  }
}, 30000);

server.listen(PORT, () => console.log('Магнат запущен на порту ' + PORT));
module.exports = { server, rooms };
