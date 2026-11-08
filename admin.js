#!/usr/bin/env node
'use strict';
/*
  Админ-консоль «Магната».
  Запуск:
    node admin.js                       (адрес и токен спросит сама)
    node admin.js wss://magnat.onrender.com
  Токен лучше передавать через переменную окружения, чтобы он не попал в историю команд:
    PowerShell:  $env:MAGNAT_TOKEN="твой-токен"; node admin.js wss://magnat.onrender.com
  Токен задаётся на сервере переменной ADMIN_TOKEN. Без неё админ-доступ выключен.
  Все действия админа попадают в журнал игры, их видят все игроки.
*/
const readline = require('readline');
const WebSocket = require('ws');

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = q => new Promise(res => rl.question(q, res));

const HELP = `
Команды (SEAT — номер игрока из команды players, начиная с 0; CODE — код комнаты):
  rooms                       список комнат
  players CODE                игроки комнаты: номер, имя, деньги, клетка
  cash CODE SEAT +500         выдать деньги (минус — списать)
  setcash CODE SEAT 1500      установить баланс
  tp CODE SEAT TILE           переставить фишку на клетку (0-39 на Классике, до 63 на Меге)
  own CODE TILE SEAT          отдать клетку игроку (SEAT = none — вернуть банку)
  jail CODE SEAT              отправить в тюрьму
  free CODE SEAT              освободить из тюрьмы
  help                        эта подсказка
  exit                        выйти
`;

(async () => {
  let url = process.argv[2] || process.env.MAGNAT_URL || '';
  if (!url) url = (await ask('Адрес сервера (например wss://magnat.onrender.com или ws://localhost:3000): ')).trim();
  url = url.replace(/^http/, 'ws').replace(/\/+$/, '');
  if (!/\/ws$/.test(url)) url += '/ws';
  let token = process.env.MAGNAT_TOKEN || '';
  if (!token) token = (await ask('Админ-токен: ')).trim();

  const ws = new WebSocket(url);
  const pending = new Map();
  let seq = 0;
  const call = payload => new Promise((res, rej) => {
    const id = ++seq;
    const timer = setTimeout(() => { pending.delete(id); rej(new Error('Сервер не ответил за 15 секунд.')); }, 15000);
    pending.set(id, d => { clearTimeout(timer); res(d); });
    ws.send(JSON.stringify(Object.assign({ t: 'admin', id, token }, payload)));
  });
  ws.on('message', raw => {
    let d; try { d = JSON.parse(raw); } catch { return; }
    if (d.t === 'admin' && pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id); }
  });
  ws.on('error', e => { console.error('Не удалось подключиться:', e.message); process.exit(1); });
  ws.on('close', () => { console.log('Соединение закрыто.'); process.exit(0); });
  await new Promise(r => ws.on('open', r));
  console.log('Подключено к', url);

  const check = await call({ cmd: 'rooms' });
  if (!check.ok) { console.error('Ошибка:', check.data); process.exit(1); }
  console.log('Вход выполнен. Напиши help, чтобы увидеть команды.');

  const show = d => {
    if (!d.ok) return console.log('✗', d.data);
    if (Array.isArray(d.data)) console.table(d.data); else console.log('✓', d.data);
  };

  for (;;) {
    const line = (await ask('магнат> ')).trim();
    if (!line) continue;
    const [cmd, ...a] = line.split(/\s+/);
    try {
      if (cmd === 'exit' || cmd === 'quit') break;
      else if (cmd === 'help') console.log(HELP);
      else if (cmd === 'rooms') show(await call({ cmd: 'rooms' }));
      else if (cmd === 'players') show(await call({ cmd: 'players', code: a[0] }));
      else if (cmd === 'cash') show(await call({ cmd: 'cash', code: a[0], seat: a[1], amount: a[2] }));
      else if (cmd === 'setcash') show(await call({ cmd: 'setcash', code: a[0], seat: a[1], amount: a[2] }));
      else if (cmd === 'tp') show(await call({ cmd: 'tp', code: a[0], seat: a[1], tile: a[2] }));
      else if (cmd === 'own') show(await call({ cmd: 'own', code: a[0], tile: a[1], seat: a[2] }));
      else if (cmd === 'jail') show(await call({ cmd: 'jail', code: a[0], seat: a[1] }));
      else if (cmd === 'free') show(await call({ cmd: 'free', code: a[0], seat: a[1] }));
      else console.log('Неизвестная команда. Напиши help.');
    } catch (e) { console.log('✗', e.message); }
  }
  ws.close(); rl.close();
})();
