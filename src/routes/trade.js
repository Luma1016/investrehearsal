const express = require('express');
const db = require('../db');
const { requireLogin } = require('../middleware');
const { isHalted, isPaused } = require('../circuit');

const router = express.Router();
router.use(requireLogin);

function checkQty(qty) {
  return Number.isInteger(qty) && qty >= 1;
}

// 서버 가상호가: 분봉 단위로 고정되는 결정적 난수 (같은 분 내 주문은 같은 호가)
function bookSeed(code) {
  let h = 0;
  for (let i = 0; i < code.length; i++) h = ((h * 31 + code.charCodeAt(i)) >>> 0);
  return (h + Math.floor(Date.now() / 60000)) >>> 0;
}
function bookRnd(seed) {
  let s = seed || 1;
  return () => {
    s = (s * 1103515245 + 12345) % 2147483648;
    return s / 2147483648;
  };
}
function buildBook(code, curPrice) {
  const rnd = bookRnd(bookSeed(code));
  const step = Math.max(10, Math.round(curPrice * 0.003));
  const asks = [];
  const bids = [];
  for (let i = 1; i <= 10; i++) {
    asks.push({ px: curPrice + step * i, q: Math.floor(rnd() * 400) + 20 });
    bids.push({ px: curPrice - step * i, q: Math.floor(rnd() * 400) + 20 });
  }
  return { code, cur_price: curPrice, step, asks, bids };
}

// 슬리피지 체결가: 호가를 레벨대로 소진하며 평균단가 계산 (잔량 초과분은 다음 호가로)
function walkBook(side, book, qty) {
  const levels = side === 'BUY' ? book.asks : book.bids;
  let left = qty, cost = 0, used = 0;
  let i = 0;
  while (left > 0) {
    const lv = levels[i] || { px: levels[levels.length - 1].px + (side === 'BUY' ? book.step : -book.step), q: 50 };
    if (!levels[i]) levels.push(lv);
    const take = Math.min(left, lv.q);
    cost += take * lv.px;
    left -= take;
    used++;
    i++;
    if (i > 500) break;
  }
  return { avg: Math.max(1, Math.round(cost / qty)), levels: used };
}

// 시장가 매수 실행 (즉시주문 + 예약체결 공용): 슬리피지 평균가로 holdings upsert + 현금차감 + BUY 기록
// 성공 {ok:true, avgPrice, cash}, 실패 {ok:false, error}
function fillBuy(userId, code, qty) {
  if (!checkQty(qty)) return { ok: false, error: 'INVALID_QTY' };
  const stock = db.prepare('SELECT * FROM stocks WHERE code = ?').get(code);
  if (!stock) return { ok: false, error: 'NOT_FOUND' };
  if (stock.status === '정지') return { ok: false, error: 'FORBIDDEN' };
  if (isHalted(code)) return { ok: false, error: 'CIRCUIT_HALT' };
  if (isPaused(code)) return { ok: false, error: 'CIRCUIT_PAUSE' };
  const book = buildBook(code, stock.cur_price);
  const { avg } = walkBook('BUY', book, qty);
  const cost = avg * qty;
  const acc = db.prepare('SELECT cash FROM accounts WHERE user_id = ?').get(userId);
  if (!acc || acc.cash < cost) return { ok: false, error: 'CASH_LACK' };
  const tx = db.transaction(() => {
    const h = db.prepare('SELECT qty, avg_price FROM holdings WHERE user_id = ? AND stock_code = ?')
      .get(userId, code);
    if (h) {
      const nq = h.qty + qty;
      const na = Math.round((h.avg_price * h.qty + avg * qty) / nq);
      db.prepare('UPDATE holdings SET qty = ?, avg_price = ? WHERE user_id = ? AND stock_code = ?')
        .run(nq, na, userId, code);
    } else {
      db.prepare('INSERT INTO holdings (user_id, stock_code, qty, avg_price) VALUES (?,?,?,?)')
        .run(userId, code, qty, avg);
    }
    db.prepare('UPDATE accounts SET cash = cash - ? WHERE user_id = ?').run(cost, userId);
    db.prepare(
      'INSERT INTO transactions (user_id, stock_code, side, qty, price) VALUES (?,?,\'BUY\',?,?)'
    ).run(userId, code, qty, avg);
  });
  tx();
  const cash = db.prepare('SELECT cash FROM accounts WHERE user_id = ?').get(userId).cash;
  return { ok: true, avgPrice: avg, cash };
}

// 시장가 매도 실행: 매수호가 기준으로 슬리피지 평균가 체결
function fillSell(userId, code, qty) {
  if (!checkQty(qty)) return { ok: false, error: 'INVALID_QTY' };
  const stock = db.prepare('SELECT * FROM stocks WHERE code = ?').get(code);
  if (!stock) return { ok: false, error: 'NOT_FOUND' };
  if (stock.status === '정지') return { ok: false, error: 'FORBIDDEN' };
  if (isHalted(code)) return { ok: false, error: 'CIRCUIT_HALT' };
  if (isPaused(code)) return { ok: false, error: 'CIRCUIT_PAUSE' };
  const h = db.prepare('SELECT qty, avg_price FROM holdings WHERE user_id = ? AND stock_code = ?')
    .get(userId, code);
  if (!h || h.qty < qty) return { ok: false, error: 'HOLDING_LACK' };
  const book = buildBook(code, stock.cur_price);
  const { avg } = walkBook('SELL', book, qty);
  const proceeds = avg * qty;
  const pnl = (avg - h.avg_price) * qty;
  const tx = db.transaction(() => {
    const left = h.qty - qty;
    if (left === 0) {
      db.prepare('DELETE FROM holdings WHERE user_id = ? AND stock_code = ?').run(userId, code);
    } else {
      db.prepare('UPDATE holdings SET qty = ? WHERE user_id = ? AND stock_code = ?')
        .run(left, userId, code);
    }
    db.prepare('UPDATE accounts SET cash = cash + ? WHERE user_id = ?').run(proceeds, userId);
    db.prepare(
      'INSERT INTO transactions (user_id, stock_code, side, qty, price, pnl) VALUES (?,?,\'SELL\',?,?,?)'
    ).run(userId, code, qty, avg, pnl);
  });
  tx();
  const cash = db.prepare('SELECT cash FROM accounts WHERE user_id = ?').get(userId).cash;
  return { ok: true, avgPrice: avg, pnl, cash };
}

// POST /api/trade/buy {code, qty}
router.post('/buy', (req, res) => {
  const { code, qty } = req.body || {};
  if (!code || !checkQty(qty)) return res.status(400).json({ error: 'INVALID_QTY' });
  const r = fillBuy(req.user.id, code, qty);
  if (!r.ok) {
    const st = r.error === 'FORBIDDEN' || r.error === 'CIRCUIT_HALT' || r.error === 'CIRCUIT_PAUSE' ? 403 : r.error === 'NOT_FOUND' ? 404 : 400;
    return res.status(st).json({ error: r.error });
  }
  res.status(201).json({ ok: true, price: r.avgPrice, qty, cash: r.cash });
});

// GET /api/trade/book?code= (가상호가 조회: 체결 기준과 동일)
router.get('/book', (req, res) => {
  const code = (req.query.code || '').trim();
  if (!code) return res.status(400).json({ error: 'INVALID_INPUT' });
  const stock = db.prepare('SELECT * FROM stocks WHERE code = ?').get(code);
  if (!stock) return res.status(404).json({ error: 'NOT_FOUND' });
  res.json(buildBook(code, stock.cur_price));
});

// POST /api/trade/sell {code, qty}
router.post('/sell', (req, res) => {
  const { code, qty } = req.body || {};
  if (!code || !checkQty(qty)) return res.status(400).json({ error: 'INVALID_QTY' });
  const r = fillSell(req.user.id, code, qty);
  if (!r.ok) {
    const st = r.error === 'FORBIDDEN' || r.error === 'CIRCUIT_HALT' || r.error === 'CIRCUIT_PAUSE' ? 403 : r.error === 'NOT_FOUND' ? 404 : 400;
    return res.status(st).json({ error: r.error });
  }
  res.json({ ok: true, price: r.avgPrice, qty, pnl: r.pnl, cash: r.cash });
});

// POST /api/trade/reserve {code, qty, target_price} (예약매수: 현재가가 목표가 이하가 되면 다음 틱에 자동 체결)
router.post('/reserve', (req, res) => {
  const { code, qty, target_price } = req.body || {};
  if (!code || !checkQty(qty) || !Number.isInteger(target_price) || target_price < 1) {
    return res.status(400).json({ error: 'INVALID_INPUT' });
  }
  const stock = db.prepare('SELECT * FROM stocks WHERE code = ?').get(code);
  if (!stock) return res.status(404).json({ error: 'NOT_FOUND' });
  if (stock.status === '정지') return res.status(403).json({ error: 'FORBIDDEN' });
  const acc = db.prepare('SELECT cash FROM accounts WHERE user_id = ?').get(req.user.id);
  if (!acc || acc.cash < target_price * qty) return res.status(400).json({ error: 'CASH_LACK' });
  const r = db.prepare(
    "INSERT INTO reservations (user_id, stock_code, qty, target_price) VALUES (?,?,?,?)"
  ).run(req.user.id, code, qty, target_price);
  res.status(201).json(db.prepare('SELECT * FROM reservations WHERE id = ?').get(r.lastInsertRowid));
});

// GET /api/trade/reserves (내 예약 목록)
router.get('/reserves', (req, res) => {
  res.json(db.prepare(
    'SELECT r.*, s.name, s.cur_price FROM reservations r JOIN stocks s ON s.code = r.stock_code WHERE r.user_id = ? ORDER BY r.id DESC LIMIT 50'
  ).all(req.user.id));
});

// DELETE /api/trade/reserves/:id (대기 예약 취소, 본인만)
router.delete('/reserves/:id', (req, res) => {
  const r = db.prepare('SELECT * FROM reservations WHERE id = ?').get(req.params.id);
  if (!r) return res.status(404).json({ error: 'NOT_FOUND' });
  if (r.user_id !== req.user.id) return res.status(403).json({ error: 'FORBIDDEN' });
  if (r.status !== '대기') return res.status(400).json({ error: 'ALREADY_DONE' });
  db.prepare("UPDATE reservations SET status = '취소' WHERE id = ?").run(r.id);
  res.json({ ok: true });
});

module.exports = { router, fillBuy };
