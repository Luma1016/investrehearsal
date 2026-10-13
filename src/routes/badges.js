const express = require('express');
const db = require('../db');
const { requireLogin } = require('../middleware');

const router = express.Router();

// 자동 칭호 계산 (실시간 집계, 저장 없음)
// 기부왕=누적기부 1위, 도박왕=누적베팅 1위, 주식왕=주식평가액 1위, 배당왕=누적배당 1위
function calcTitles() {
  const pick = (sql) => {
    try {
      return db.prepare(sql).get() || null;
    } catch (e) {
      return null;
    }
  };
  const nick = (uid) => {
    if (!uid) return null;
    const u = db.prepare('SELECT nickname, status FROM users WHERE id = ?').get(uid);
    if (!u) return null;
    return u.status === '탈퇴' ? '탈퇴회원' : u.nickname;
  };
  const donor = pick('SELECT user_id AS uid, SUM(amount) AS total FROM donations GROUP BY user_id ORDER BY total DESC LIMIT 1');
  const gambler = pick('SELECT user_id AS uid, SUM(bet) AS total FROM gambles GROUP BY user_id ORDER BY total DESC LIMIT 1');
  const stocker = pick(`SELECT h.user_id AS uid, SUM(h.qty * s.cur_price) AS total FROM holdings h JOIN stocks s ON s.code = h.stock_code GROUP BY h.user_id ORDER BY total DESC LIMIT 1`);
  const diver = pick('SELECT user_id AS uid, SUM(amount) AS total FROM dividend_logs GROUP BY user_id ORDER BY total DESC LIMIT 1');
  const out = {};
  if (donor && donor.total > 0) out.기부왕 = { nickname: nick(donor.uid), user_id: donor.uid, total: donor.total };
  if (gambler && gambler.total > 0) out.도박왕 = { nickname: nick(gambler.uid), user_id: gambler.uid, total: gambler.total };
  if (stocker && stocker.total > 0) out.주식왕 = { nickname: nick(stocker.uid), user_id: stocker.uid, total: stocker.total };
  if (diver && diver.total > 0) out.배당왕 = { nickname: nick(diver.uid), user_id: diver.uid, total: diver.total };
  return out;
}

// GET /api/badges (상점 목록 + 내 보유/장착 + 자동 칭호)
router.get('/', (req, res) => {
  const uid = req.session && req.session.userId ? req.session.userId : null;
  const shop = db.prepare('SELECT * FROM badges ORDER BY price, id').all();
  let owned = [];
  let equipped = null;
  let myTitles = [];
  if (uid) {
    owned = db.prepare('SELECT badge_id FROM user_badges WHERE user_id = ?').all(uid).map((r) => r.badge_id);
    const me = db.prepare('SELECT display_badge FROM users WHERE id = ?').get(uid);
    equipped = me ? me.display_badge : null;
    const t = calcTitles();
    myTitles = Object.entries(t).filter(([, v]) => v.user_id === uid).map(([k]) => k);
  }
  res.json({ shop, owned, equipped, titles: calcTitles(), myTitles });
});

// POST /api/badges/:id/buy (예수금으로 구매 = 돈 소비처)
router.post('/:id/buy', requireLogin, (req, res) => {
  const b = db.prepare('SELECT * FROM badges WHERE id = ?').get(req.params.id);
  if (!b) return res.status(404).json({ error: 'NOT_FOUND' });
  if (db.prepare('SELECT 1 FROM user_badges WHERE user_id = ? AND badge_id = ?').get(req.user.id, b.id)) {
    return res.status(400).json({ error: 'ALREADY_OWNED' });
  }
  const acc = db.prepare('SELECT cash FROM accounts WHERE user_id = ?').get(req.user.id);
  if (!acc || acc.cash < b.price) return res.status(400).json({ error: 'CASH_LACK' });
  const tx = db.transaction(() => {
    db.prepare('UPDATE accounts SET cash = cash - ? WHERE user_id = ?').run(b.price, req.user.id);
    db.prepare('INSERT INTO user_badges (user_id, badge_id) VALUES (?,?)').run(req.user.id, b.id);
  });
  tx();
  res.status(201).json({ ok: true });
});

// POST /api/badges/equip {badge_id|null} (프로필 장착, 보유한 것만)
router.post('/equip', requireLogin, (req, res) => {
  const { badge_id } = req.body || {};
  if (badge_id === null || badge_id === undefined || badge_id === '') {
    db.prepare('UPDATE users SET display_badge = NULL WHERE id = ?').run(req.user.id);
    return res.json({ ok: true, equipped: null });
  }
  const b = db.prepare('SELECT * FROM badges WHERE id = ?').get(badge_id);
  if (!b) return res.status(404).json({ error: 'NOT_FOUND' });
  if (!db.prepare('SELECT 1 FROM user_badges WHERE user_id = ? AND badge_id = ?').get(req.user.id, b.id)) {
    return res.status(403).json({ error: 'NOT_OWNED' });
  }
  db.prepare('UPDATE users SET display_badge = ? WHERE id = ?').run(b.id, req.user.id);
  res.json({ ok: true, equipped: b.id });
});

module.exports = { router, calcTitles };
