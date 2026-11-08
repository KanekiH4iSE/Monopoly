/* Общие данные игры: подключаются и сервером (require), и браузером (<script>) */
(function (root) {
  const GROUPS = {
    brown:  { c: '#8d5a3b', house: 50,  name: 'Коричневые' },
    lblue:  { c: '#79c7e6', house: 50,  name: 'Голубые' },
    pink:   { c: '#e0529c', house: 100, name: 'Розовые' },
    orange: { c: '#f28c28', house: 100, name: 'Оранжевые' },
    red:    { c: '#d63a3a', house: 150, name: 'Красные' },
    yellow: { c: '#f2cf2e', house: 150, name: 'Жёлтые' },
    green:  { c: '#2a9d5c', house: 200, name: 'Зелёные' },
    dblue:  { c: '#2a4cb5', house: 200, name: 'Синие' },
    station:{ c: '#6b7a85', house: 0,   name: 'Вокзалы' },
    util:   { c: '#a7a05a', house: 0,   name: 'Коммунальные' }
  };
  GROUPS.teal = { c: '#14b8a6', house: 100, name: 'Бирюзовые' };
  GROUPS.violet = { c: '#8e44ad', house: 150, name: 'Фиолетовые' };
  const S = (name, grp, price, rent) => ({ type: 'street', name, grp, price, rent });
  const ST = name => ({ type: 'station', name, price: 200 });
  const UT = name => ({ type: 'util', name, price: 150 });
  const TX = (name, amount, icon) => ({ type: 'tax', name, amount, icon });
  const CH = { type: 'chance', name: 'Шанс' }, CS = { type: 'chest', name: 'Сюрприз' };
  const GO = { type: 'go', name: 'СТАРТ' }, JAIL = { type: 'jail', name: 'Тюрьма' };
  const PARK = { type: 'parking', name: 'Бесплатная парковка' }, GOJ = { type: 'gojail', name: 'В тюрьму!' };

  /* Названия и цены клеток можно менять здесь */
  const T = {
    hanoi: S('Ханой', 'brown', 60, [2, 10, 30, 90, 160, 250]),
    manila: S('Манила', 'brown', 60, [4, 20, 60, 180, 320, 450]),
    jakarta: S('Джакарта', 'brown', 80, [5, 25, 75, 210, 360, 520]),
    lagos: S('Лагос', 'brown', 80, [5, 25, 75, 210, 360, 520]),
    cairo: S('Каир', 'lblue', 100, [6, 30, 90, 270, 400, 550]),
    lima: S('Лима', 'lblue', 100, [6, 30, 90, 270, 400, 550]),
    bogota: S('Богота', 'lblue', 120, [8, 40, 100, 300, 450, 600]),
    casablanca: S('Касабланка', 'lblue', 130, [9, 45, 120, 350, 500, 650]),
    istanbul: S('Стамбул', 'pink', 140, [10, 50, 150, 450, 625, 750]),
    athens: S('Афины', 'pink', 140, [10, 50, 150, 450, 625, 750]),
    lisbon: S('Лиссабон', 'pink', 160, [12, 60, 180, 500, 700, 900]),
    barcelona: S('Барселона', 'pink', 170, [13, 65, 195, 525, 725, 925]),
    prague: S('Прага', 'orange', 180, [14, 70, 200, 550, 750, 950]),
    vienna: S('Вена', 'orange', 180, [14, 70, 200, 550, 750, 950]),
    budapest: S('Будапешт', 'orange', 200, [16, 80, 220, 600, 800, 1000]),
    krakow: S('Краков', 'orange', 210, [18, 90, 250, 625, 825, 1025]),
    sydney: S('Сидней', 'teal', 210, [17, 85, 240, 620, 820, 1020]),
    melbourne: S('Мельбурн', 'teal', 220, [18, 90, 255, 650, 850, 1040]),
    madrid: S('Мадрид', 'red', 220, [18, 90, 250, 700, 875, 1050]),
    rome: S('Рим', 'red', 220, [18, 90, 250, 700, 875, 1050]),
    berlin: S('Берлин', 'red', 240, [20, 100, 300, 750, 925, 1100]),
    milan: S('Милан', 'red', 250, [21, 105, 315, 775, 950, 1125]),
    seoul: S('Сеул', 'yellow', 260, [22, 110, 330, 800, 975, 1150]),
    singapore: S('Сингапур', 'yellow', 260, [22, 110, 330, 800, 975, 1150]),
    tokyo: S('Токио', 'yellow', 280, [24, 120, 360, 850, 1025, 1200]),
    osaka: S('Осака', 'yellow', 290, [26, 130, 380, 875, 1050, 1225]),
    toronto: S('Торонто', 'violet', 290, [25, 125, 370, 860, 1040, 1215]),
    vancouver: S('Ванкувер', 'violet', 290, [25, 125, 370, 860, 1040, 1215]),
    montreal: S('Монреаль', 'violet', 310, [27, 135, 400, 950, 1150, 1325]),
    london: S('Лондон', 'green', 300, [26, 130, 390, 900, 1100, 1275]),
    paris: S('Париж', 'green', 300, [26, 130, 390, 900, 1100, 1275]),
    dubai: S('Дубай', 'green', 320, [28, 150, 450, 1000, 1200, 1400]),
    amsterdam: S('Амстердам', 'green', 330, [30, 160, 480, 1050, 1250, 1450]),
    newyork: S('Нью‑Йорк', 'dblue', 350, [35, 175, 500, 1100, 1300, 1500]),
    shanghai: S('Шанхай', 'dblue', 380, [45, 190, 550, 1250, 1500, 1800]),
    hongkong: S('Гонконг', 'dblue', 400, [50, 200, 600, 1400, 1700, 2000]),
    stN: ST('Северный вокзал'), stE: ST('Восточный порт'), stS: ST('Южный аэропорт'), stW: ST('Западный терминал'),
    stC: ST('Центральная станция'), stSea: ST('Морской порт'), stCargo: ST('Грузовой порт'),
    utE: UT('Электростанция'), utW: UT('Водоканал'), utI: UT('Интернет‑провайдер'), utG: UT('Газовая служба'),
    taxI: TX('Налог на доход', 200, '💸'), taxL: TX('Налог на роскошь', 100, '💎'), taxP: TX('Налог на недвижимость', 150, '🏛️')
  };
  const gk = t => (t.type === 'street' ? t.grp : t.type);

  function makeMap(key, label, note, sides, view) {
    const BOARD = [GO, ...sides.bottom, JAIL, ...sides.left, PARK, ...sides.top, GOJ, ...sides.right];
    const GROUP_IDX = {};
    BOARD.forEach((t, i) => {
      if (['street', 'station', 'util'].includes(t.type)) (GROUP_IDX[gk(t)] = GROUP_IDX[gk(t)] || []).push(i);
    });
    const S4 = BOARD.length / 4;
    return Object.assign({ key, label, note, BOARD, GROUP_IDX, N: BOARD.length, S: S4, jail: S4, gojail: 3 * S4 }, view);
  }
  const MAPS = {
    classic: makeMap('classic', 'Классика', '40 клеток, для 2–6 игроков', {
      bottom: [T.hanoi, CS, T.manila, T.taxI, T.stN, T.cairo, CH, T.lima, T.bogota],
      left: [T.istanbul, T.utE, T.athens, T.lisbon, T.stE, T.prague, CS, T.vienna, T.budapest],
      top: [T.madrid, CH, T.rome, T.berlin, T.stS, T.seoul, T.singapore, T.utW, T.tokyo],
      right: [T.london, T.paris, CS, T.dubai, T.stW, CH, T.newyork, T.taxL, T.hongkong]
    }, { scale: 1, tk: 1, tf: 1 }),
    large: makeMap('large', 'Большая', '48 клеток, для 7–8 игроков', {
      bottom: [T.hanoi, CS, T.manila, T.jakarta, T.taxI, T.stN, T.cairo, CH, T.lima, T.bogota, T.utI],
      left: [T.istanbul, T.utE, T.athens, T.lisbon, T.stE, T.prague, CS, T.vienna, T.budapest, T.sydney, T.melbourne],
      top: [T.madrid, CH, T.rome, T.berlin, T.stS, CS, T.seoul, T.singapore, T.utW, T.tokyo, T.stC],
      right: [T.london, T.paris, CS, T.dubai, CH, T.stW, CH, T.newyork, T.taxL, T.shanghai, T.hongkong]
    }, { scale: 1.1, tk: .92, tf: .95 }),
    xl: makeMap('xl', 'Гигант', '56 клеток, для 9–10 игроков', {
      bottom: [T.hanoi, CS, T.manila, T.jakarta, T.taxI, T.stN, T.cairo, CH, T.lima, T.bogota, T.casablanca, T.utI, T.stSea],
      left: [T.istanbul, T.utE, T.athens, T.lisbon, T.barcelona, T.stE, T.prague, CS, T.vienna, T.budapest, T.krakow, T.sydney, T.melbourne],
      top: [T.madrid, CH, T.rome, T.berlin, T.milan, T.stS, CS, T.seoul, T.singapore, T.utW, T.tokyo, T.osaka, T.stC],
      right: [T.london, T.paris, CS, T.dubai, T.amsterdam, CH, T.stW, T.taxP, CH, T.newyork, T.taxL, T.shanghai, T.hongkong]
    }, { scale: 1.2, tk: .85, tf: .9 }),
    mega: makeMap('mega', 'Мега', '64 клетки, для 11–12 игроков', {
      bottom: [T.hanoi, CS, T.manila, T.jakarta, T.lagos, T.taxI, T.stN, T.cairo, CH, T.lima, T.bogota, T.casablanca, T.utI, T.stSea, CS],
      left: [T.istanbul, T.utE, T.athens, T.lisbon, T.barcelona, T.stE, T.prague, CS, T.vienna, T.budapest, T.krakow, CH, T.sydney, T.melbourne, T.utG],
      top: [T.madrid, CH, T.rome, T.berlin, T.milan, T.stS, CS, T.seoul, T.singapore, T.utW, T.tokyo, T.osaka, T.stC, T.toronto, T.vancouver],
      right: [T.montreal, T.london, T.paris, CS, T.dubai, T.amsterdam, CH, T.stW, T.taxP, CH, T.newyork, T.taxL, T.shanghai, T.stCargo, T.hongkong]
    }, { scale: 1.3, tk: .8, tf: .85 })
  };
  const autoMap = n => (n <= 6 ? 'classic' : n <= 8 ? 'large' : n <= 10 ? 'xl' : 'mega');
  const BOARD = MAPS.classic.BOARD, GROUP_IDX = MAPS.classic.GROUP_IDX;

  const TOKENS = [['🚗', '#e63946'], ['🎩', '#3a86ff'], ['🐶', '#e8913a'], ['🚀', '#8338ec'], ['👑', '#d9a400'],
                  ['🐱', '#2a9d8f'], ['🛸', '#00a6c8'], ['🦄', '#ff4fa3'], ['⚓', '#5c677d'], ['🎸', '#b5651d']];

  const CHANCE = [
    { t: 'goto', to: 0, text: 'Отправляйся на СТАРТ и получи $200.' },
    { t: 'goto', to: 'Нью‑Йорк', text: 'Поездка в Нью‑Йорк! Двигайся на «Нью‑Йорк». Проходишь СТАРТ — получи $200.' },
    { t: 'goto', to: 'Лондон', text: 'Отправляйся в Лондон. Проходишь СТАРТ — получи $200.' },
    { t: 'goto', to: 'Стамбул', text: 'Отправляйся в Стамбул. Проходишь СТАРТ — получи $200.' },
    { t: 'goto', to: 'Северный вокзал', text: 'Отправляйся на Северный вокзал. Проходишь СТАРТ — получи $200.' },
    { t: 'near', k: 'station', text: 'Ближайший вокзал. Если он занят — заплати владельцу вдвое больше обычного.' },
    { t: 'near', k: 'station', text: 'Ближайший вокзал. Если он занят — заплати владельцу вдвое больше обычного.' },
    { t: 'near', k: 'util', text: 'Ближайшая коммунальная служба. Если занята — брось кубики и заплати 10× от выпавшего.' },
    { t: 'gain', n: 50, text: 'Банк выплатил тебе дивиденды: $50.' },
    { t: 'jf', text: 'Карта «Освобождение из тюрьмы». Сохрани её, пока не пригодится.' },
    { t: 'back', n: 3, text: 'Шаг назад: вернись на 3 клетки.' },
    { t: 'jail', text: 'Отправляйся прямо в тюрьму! СТАРТ не проходишь, $200 не получаешь.' },
    { t: 'repair', h: 25, H: 100, text: 'Генеральный ремонт: $25 за каждый дом и $100 за каждый отель.' },
    { t: 'loss', n: 15, text: 'Штраф за превышение скорости: $15.' },
    { t: 'payeach', n: 50, text: 'Тебя избрали председателем клуба: заплати каждому игроку по $50.' },
    { t: 'gain', n: 150, text: 'Твой вклад созрел: получи $150.' }
  ];
  const CHEST = [
    { t: 'goto', to: 0, text: 'Отправляйся на СТАРТ и получи $200.' },
    { t: 'gain', n: 200, text: 'Банковская ошибка в твою пользу: получи $200.' },
    { t: 'loss', n: 50, text: 'Счёт от врача: заплати $50.' },
    { t: 'gain', n: 50, text: 'Ты продал акции: получи $50.' },
    { t: 'jf', text: 'Карта «Освобождение из тюрьмы». Сохрани её, пока не пригодится.' },
    { t: 'jail', text: 'Отправляйся прямо в тюрьму! СТАРТ не проходишь, $200 не получаешь.' },
    { t: 'getall', n: 10, text: 'Праздник! Каждый игрок дарит тебе по $10.' },
    { t: 'gain', n: 20, text: 'Возврат налога: получи $20.' },
    { t: 'gain', n: 100, text: 'Страховка созрела: получи $100.' },
    { t: 'loss', n: 100, text: 'Оплата больницы: $100.' },
    { t: 'loss', n: 50, text: 'Школьный сбор: $50.' },
    { t: 'gain', n: 25, text: 'Гонорар за консультацию: получи $25.' },
    { t: 'repair', h: 40, H: 115, text: 'Ремонт улиц: $40 за каждый дом и $115 за каждый отель.' },
    { t: 'gain', n: 10, text: 'Второе место на конкурсе красоты: получи $10.' },
    { t: 'gain', n: 100, text: 'Тебе досталось наследство: $100.' }
  ];

  const EMOJIS = ['🚗','🎩','🐶','🚀','👑','🐱','🛸','🦄','⚓','🎸','🦊','🐼','🐸','🐙','🦁','🐯','🐵','🦖','🐢','🦉',
                  '🍕','🍔','🍩','🎮','⚽','🏀','🎲','💎','🔥','⭐','🌵','🤖','👻','🏎️','🚁','🎯'];
  const COLORS = ['#e63946','#3a86ff','#e8913a','#8338ec','#d9a400','#2a9d8f','#00a6c8','#ff4fa3','#5c677d','#b5651d','#2f9e44','#212529'];
  const MAG = { GROUPS, BOARD, GROUP_IDX, MAPS, autoMap, TOKENS, CHANCE, CHEST, EMOJIS, COLORS, gk };
  if (typeof module !== 'undefined' && module.exports) module.exports = MAG;
  else root.MAG = MAG;
})(typeof self !== 'undefined' ? self : globalThis);
