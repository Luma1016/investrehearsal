const express = require('express');
const db = require('../db');
const { requireLogin } = require('../middleware');

const router = express.Router();
router.use(requireLogin);

function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function buildPortfolio(userId) {
  const acc = db.prepare('SELECT cash, init_cash FROM accounts WHERE user_id = ?').get(userId);
  const rows = db.prepare(
    `SELECT h.stock_code AS code, s.name, h.qty, h.avg_price AS avg, s.cur_price AS cur
     FROM holdings h JOIN stocks s ON s.code = h.stock_code
     WHERE h.user_id = ? ORDER BY h.stock_code`
  ).all(userId);
  let stockVal = 0;
  const items = rows.map((r) => {
    const pnl = (r.cur - r.avg) * r.qty;
    const rate = r.avg ? (r.cur - r.avg) / r.avg : 0;
    stockVal += r.cur * r.qty;
    return { ...r, pnl, rate };
  });
  const cash = acc ? acc.cash : 0;
  const init = acc ? acc.init_cash : 10000000;
  const total = cash + stockVal;
  const profit = total - init;
  const rate = init ? profit / init : 0;
  // 하루 1회 스냅샷 (upsert)
  db.prepare(
    `INSERT INTO asset_history (user_id, date, total) VALUES (?,?,?)
     ON CONFLICT(user_id, date) DO UPDATE SET total = excluded.total`
  ).run(userId, todayStr(), total);
  return { cash, init_cash: init, stockVal, total, profit, rate, items };
}

// GET /api/portfolio
router.get('/portfolio', (req, res) => {
  res.json(buildPortfolio(req.user.id));
});

// GET /api/assets (그래프용 스냅샷 목록)
router.get('/assets', (req, res) => {
  buildPortfolio(req.user.id); // 오늘치 보장
  const rows = db.prepare(
    'SELECT date, total FROM asset_history WHERE user_id = ? ORDER BY date'
  ).all(req.user.id);
  res.json(rows);
});

// GET /api/history?type=&code=&from=&to=
router.get('/history', (req, res) => {
  const { type, code, from, to } = req.query;
  const conds = ['user_id = ?'];
  const params = [req.user.id];
  if (type === 'BUY' || type === 'SELL') {
    conds.push('side = ?');
    params.push(type);
  }
  if (code) {
    conds.push('stock_code = ?');
    params.push(code);
  }
  if (from) {
    conds.push('date(created_at) >= date(?)');
    params.push(from);
  }
  if (to) {
    conds.push('date(created_at) <= date(?)');
    params.push(to);
  }
  const rows = db.prepare(
    `SELECT id, stock_code, side, qty, price, pnl, created_at FROM transactions
     WHERE ${conds.join(' AND ')} ORDER BY id DESC LIMIT 200`
  ).all(...params);
  res.json(rows);
});

module.exports = router;
