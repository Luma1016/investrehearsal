const express = require('express');
const db = require('../db');
const { requireLogin } = require('../middleware');
const { isHalted, isPaused } = require('../circuit');

const router = express.Router();

function tradable(stock) {
  if (!stock) return 'NOT_FOUND';
  if (stock.status === '정지') return 'FORBIDDEN';
  if (isHalted(stock.code)) return 'CIRCUIT_HALT';
  if (isPaused(stock.code)) return 'CIRCUIT_PAUSE';
  return null;
}

// GET /api/block (열린 제안 목록, 매도자 익명)
router.get('/', (req, res) => {
  const uid = req.session && req.session.userId ? req.session.userId : null;
  const rows = db.prepare(
    `SELECT b.id, b.stock_code, s.name, b.qty, b.price, b.created_at, b.seller_id
     FROM block_deals b JOIN stocks s ON s.code = b.stock_code
     WHERE b.status = '제안' ORDER BY b.id DESC LIMIT 50`
  ).all();
  res.json(rows.map((r) => ({ id: r.id, stock_code: r.stock_code, name: r.name, qty: r.qty, price: r.price, created_at: r.created_at, mine: uid === r.seller_id })));
});

// GET /api/block/mine (내 제안·체결 내역)
router.get('/mine', requireLogin, (req, res) => {
  res.json(db.prepare(
    `SELECT b.*, s.name FROM block_deals b JOIN stocks s ON s.code = b.stock_code
     WHERE b.seller_id = ? OR b.buyer_id = ? ORDER BY b.id DESC LIMIT 50`
  ).all(req.user.id, req.user.id));
});

// POST /api/block {code, qty, price} (매도 제안: 시장가 영향 없음)
router.post('/', requireLogin, (req, res) => {
  const { code, qty, price } = req.body || {};
  if (!code || !Number.isInteger(qty) || qty < 1) return res.status(400).json({ error: 'INVALID_QTY' });
  if (!Number.isInteger(price) || price < 1) return res.status(400).json({ error: 'INVALID_PRICE' });
  const stock = db.prepare('SELECT * FROM stocks WHERE code = ?').get(code);
  const terr = tradable(stock);
  if (terr) {
    const st = terr === 'NOT_FOUND' ? 404 : terr === 'FORBIDDEN' || terr.startsWith('CIRCUIT') ? 403 : 400;
    return res.status(st).json({ error: terr });
  }
  const h = db.prepare('SELECT qty FROM holdings WHERE user_id = ? AND stock_code = ?').get(req.user.id, code);
  if (!h || h.qty < qty) return res.status(400).json({ error: 'HOLDING_LACK' });
  const r = db.prepare('INSERT INTO block_deals (seller_id, stock_code, qty, price) VALUES (?,?,?,?)')
    .run(req.user.id, code, qty, price);
  res.status(201).json(db.prepare('SELECT * FROM block_deals WHERE id = ?').get(r.lastInsertRowid));
});

// POST /api/block/:id/accept (지정가로 보유 이전, 시세 무영향)
router.post('/:id/accept', requireLogin, (req, res) => {
  const b = db.prepare('SELECT * FROM block_deals WHERE id = ?').get(req.params.id);
  if (!b || b.status !== '제안') return res.status(404).json({ error: 'NOT_FOUND' });
  if (b.seller_id === req.user.id) return res.status(400).json({ error: 'SELF_DEAL' });
  const stock = db.prepare('SELECT * FROM stocks WHERE code = ?').get(b.stock_code);
  const terr = tradable(stock);
  if (terr) {
    const st = terr === 'NOT_FOUND' ? 404 : 403;
    return res.status(st).json({ error: terr });
  }
  const cost = b.price * b.qty;
  const acc = db.prepare('SELECT cash FROM accounts WHERE user_id = ?').get(req.user.id);
  if (!acc || acc.cash < cost) return res.status(400).json({ error: 'CASH_LACK' });
  const sh = db.prepare('SELECT qty, avg_price FROM holdings WHERE user_id = ? AND stock_code = ?').get(b.seller_id, b.stock_code);
  if (!sh || sh.qty < b.qty) {
    db.prepare("UPDATE block_deals SET status = '만료', memo = '잔량부족' WHERE id = ?").run(b.id);
    return res.status(400).json({ error: 'GONE' });
  }
  const tx = db.transaction(() => {
    // 매도자: 차감 + 현금 수령 + SELL 기록(지정가)
    const left = sh.qty - b.qty;
    if (left === 0) db.prepare('DELETE FROM holdings WHERE user_id = ? AND stock_code = ?').run(b.seller_id, b.stock_code);
    else db.prepare('UPDATE holdings SET qty = ? WHERE user_id = ? AND stock_code = ?').run(left, b.seller_id, b.stock_code);
    db.prepare('UPDATE accounts SET cash = cash + ? WHERE user_id = ?').run(cost, b.seller_id);
    db.prepare("INSERT INTO transactions (user_id, stock_code, side, qty, price, pnl, via) VALUES (?,?,'SELL',?,?,?,'BLOCK')")
      .run(b.seller_id, b.stock_code, b.qty, b.price, (b.price - sh.avg_price) * b.qty);
    // 매수자: 평균단가 반영 + 현금 차감 + BUY 기록(지정가)
    const bh = db.prepare('SELECT qty, avg_price FROM holdings WHERE user_id = ? AND stock_code = ?').get(req.user.id, b.stock_code);
    if (bh) {
      const nq = bh.qty + b.qty;
      const na = Math.round((bh.avg_price * bh.qty + b.price * b.qty) / nq);
      db.prepare('UPDATE holdings SET qty = ?, avg_price = ? WHERE user_id = ? AND stock_code = ?').run(nq, na, req.user.id, b.stock_code);
    } else {
      db.prepare('INSERT INTO holdings (user_id, stock_code, qty, avg_price) VALUES (?,?,?,?)').run(req.user.id, b.stock_code, b.qty, b.price);
    }
    db.prepare('UPDATE accounts SET cash = cash - ? WHERE user_id = ?').run(cost, req.user.id);
    db.prepare("INSERT INTO transactions (user_id, stock_code, side, qty, price, via) VALUES (?,?,'BUY',?,?,'BLOCK')")
      .run(req.user.id, b.stock_code, b.qty, b.price);
    db.prepare("UPDATE block_deals SET status = '체결', buyer_id = ?, executed_at = datetime('now','localtime') WHERE id = ?").run(req.user.id, b.id);
  });
  tx();
  res.status(201).json({ ok: true, price: b.price, qty: b.qty });
});

// DELETE /api/block/:id (제안 취소, 본인만)
router.delete('/:id', requireLogin, (req, res) => {
  const b = db.prepare('SELECT * FROM block_deals WHERE id = ?').get(req.params.id);
  if (!b) return res.status(404).json({ error: 'NOT_FOUND' });
  if (b.seller_id !== req.user.id) return res.status(403).json({ error: 'FORBIDDEN' });
  if (b.status !== '제안') return res.status(400).json({ error: 'ALREADY_DONE' });
  db.prepare("UPDATE block_deals SET status = '취소' WHERE id = ?").run(b.id);
  res.json({ ok: true });
});

module.exports = { router };
