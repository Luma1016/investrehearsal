const express = require('express');
const db = require('../db');
const { requireLogin } = require('../middleware');

const router = express.Router();

const BROKE_LINE = 1000000; // 총자산 100만원 미만이면 구제 대상
const DAILY_CAP = 500000; // 1일 지원 한도

function totalOf(userId) {
  const acc = db.prepare('SELECT cash FROM accounts WHERE user_id = ?').get(userId);
  const cash = acc ? acc.cash : 0;
  const sv = db.prepare(
    'SELECT COALESCE(SUM(h.qty * s.cur_price), 0) AS v FROM holdings h JOIN stocks s ON s.code = h.stock_code WHERE h.user_id = ?'
  ).get(userId).v;
  return cash + sv;
}

function pool() {
  db.prepare('INSERT OR IGNORE INTO angel_fund (id, balance) VALUES (1, 0)').run();
  return db.prepare('SELECT balance FROM angel_fund WHERE id = 1').get().balance;
}

// GET /api/fund (잔액 + 내 기부·수령 + 구제 가능 여부, 로그인은 수령/기부 내역용)
router.get('/', (req, res) => {
  const uid = req.session && req.session.userId ? req.session.userId : null;
  const out = { balance: pool(), broke_line: BROKE_LINE, daily_cap: DAILY_CAP, myDonated: 0, claimedToday: 0, myTotal: null, broke: false };
  if (!uid) return res.json(out);
  out.myDonated = db.prepare('SELECT COALESCE(SUM(amount),0) AS s FROM donations WHERE user_id = ?').get(uid).s;
  const today = new Date();
  const ds = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
  out.claimedToday = db.prepare('SELECT COALESCE(SUM(amount),0) AS s FROM fund_claims WHERE user_id = ? AND claim_date = ?').get(uid, ds).s;
  out.myTotal = totalOf(uid);
  out.broke = out.myTotal < BROKE_LINE;
  res.json(out);
});

// POST /api/fund/donate {amount}
router.post('/donate', requireLogin, (req, res) => {
  const amount = Math.floor(Number(req.body && req.body.amount));
  if (!Number.isInteger(amount) || amount < 100) return res.status(400).json({ error: 'INVALID_AMOUNT' });
  const acc = db.prepare('SELECT cash FROM accounts WHERE user_id = ?').get(req.user.id);
  if (!acc || acc.cash < amount) return res.status(400).json({ error: 'CASH_LACK' });
  const tx = db.transaction(() => {
    db.prepare('UPDATE accounts SET cash = cash - ? WHERE user_id = ?').run(amount, req.user.id);
    db.prepare('UPDATE angel_fund SET balance = balance + ? WHERE id = 1').run(amount);
    db.prepare('INSERT INTO donations (user_id, amount) VALUES (?,?)').run(req.user.id, amount);
  });
  tx();
  res.status(201).json({ ok: true, balance: pool() });
});

// POST /api/fund/claim (파산 구제: 1일 50만원 한도)
router.post('/claim', requireLogin, (req, res) => {
  const total = totalOf(req.user.id);
  if (total >= BROKE_LINE) return res.status(400).json({ error: 'NOT_BROKE' });
  const today = new Date();
  const ds = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
  const claimed = db.prepare('SELECT COALESCE(SUM(amount),0) AS s FROM fund_claims WHERE user_id = ? AND claim_date = ?').get(req.user.id, ds).s;
  const left = DAILY_CAP - claimed;
  if (left <= 0) return res.status(400).json({ error: 'DAILY_LIMIT' });
  const bal = pool();
  if (bal <= 0) return res.status(400).json({ error: 'EMPTY_FUND' });
  const amount = Math.min(left, bal);
  const tx = db.transaction(() => {
    db.prepare('UPDATE angel_fund SET balance = balance - ? WHERE id = 1').run(amount);
    db.prepare('UPDATE accounts SET cash = cash + ? WHERE user_id = ?').run(amount, req.user.id);
    db.prepare('INSERT INTO fund_claims (user_id, amount, claim_date) VALUES (?,?,?)').run(req.user.id, amount, ds);
  });
  tx();
  res.status(201).json({ ok: true, amount });
});

module.exports = { router, totalOf, pool, BROKE_LINE, DAILY_CAP };
