const express = require('express');
const db = require('../db');
const { requireLogin } = require('../middleware');

const router = express.Router();
router.use(requireLogin);

function checkQty(qty) {
  return Number.isInteger(qty) && qty >= 1;
}

// POST /api/trade/buy {code, qty}
router.post('/buy', (req, res) => {
  const { code, qty } = req.body || {};
  if (!code || !checkQty(qty)) return res.status(400).json({ error: 'INVALID_QTY' });
  const stock = db.prepare('SELECT * FROM stocks WHERE code = ?').get(code);
  if (!stock) return res.status(404).json({ error: 'NOT_FOUND' });
  if (stock.status === '정지') return res.status(403).json({ error: 'FORBIDDEN' });

  const price = stock.cur_price;
  const cost = price * qty;
  const acc = db.prepare('SELECT cash FROM accounts WHERE user_id = ?').get(req.user.id);
  if (!acc || acc.cash < cost) return res.status(400).json({ error: 'CASH_LACK' });

  const tx = db.transaction(() => {
    const h = db.prepare('SELECT qty, avg_price FROM holdings WHERE user_id = ? AND stock_code = ?')
      .get(req.user.id, code);
    if (h) {
      const nq = h.qty + qty;
      const na = Math.round((h.avg_price * h.qty + price * qty) / nq);
      db.prepare('UPDATE holdings SET qty = ?, avg_price = ? WHERE user_id = ? AND stock_code = ?')
        .run(nq, na, req.user.id, code);
    } else {
      db.prepare('INSERT INTO holdings (user_id, stock_code, qty, avg_price) VALUES (?,?,?,?)')
        .run(req.user.id, code, qty, price);
    }
    db.prepare('UPDATE accounts SET cash = cash - ? WHERE user_id = ?').run(cost, req.user.id);
    db.prepare(
      'INSERT INTO transactions (user_id, stock_code, side, qty, price) VALUES (?,?,\'BUY\',?,?)'
    ).run(req.user.id, code, qty, price);
  });
  tx();
  const cash = db.prepare('SELECT cash FROM accounts WHERE user_id = ?').get(req.user.id).cash;
  res.status(201).json({ ok: true, price, qty, cash });
});

// POST /api/trade/sell {code, qty}
router.post('/sell', (req, res) => {
  const { code, qty } = req.body || {};
  if (!code || !checkQty(qty)) return res.status(400).json({ error: 'INVALID_QTY' });
  const stock = db.prepare('SELECT * FROM stocks WHERE code = ?').get(code);
  if (!stock) return res.status(404).json({ error: 'NOT_FOUND' });
  if (stock.status === '정지') return res.status(403).json({ error: 'FORBIDDEN' });

  const h = db.prepare('SELECT qty, avg_price FROM holdings WHERE user_id = ? AND stock_code = ?')
    .get(req.user.id, code);
  if (!h || h.qty < qty) return res.status(400).json({ error: 'HOLDING_LACK' });

  const price = stock.cur_price;
  const proceeds = price * qty;
  const pnl = (price - h.avg_price) * qty;

  const tx = db.transaction(() => {
    const left = h.qty - qty;
    if (left === 0) {
      db.prepare('DELETE FROM holdings WHERE user_id = ? AND stock_code = ?').run(req.user.id, code);
    } else {
      db.prepare('UPDATE holdings SET qty = ? WHERE user_id = ? AND stock_code = ?')
        .run(left, req.user.id, code);
    }
    db.prepare('UPDATE accounts SET cash = cash + ? WHERE user_id = ?').run(proceeds, req.user.id);
    db.prepare(
      'INSERT INTO transactions (user_id, stock_code, side, qty, price, pnl) VALUES (?,?,\'SELL\',?,?,?)'
    ).run(req.user.id, code, qty, price, pnl);
  });
  tx();
  const cash = db.prepare('SELECT cash FROM accounts WHERE user_id = ?').get(req.user.id).cash;
  res.json({ ok: true, price, qty, pnl, cash });
});

module.exports = router;
