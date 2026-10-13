const express = require('express');
const db = require('../db');

const router = express.Router();

function dayOpen(code, cur) {
  let r = db.prepare(
    "SELECT prev FROM price_logs WHERE stock_code = ? AND date(created_at) = date('now','localtime') ORDER BY id LIMIT 1"
  ).get(code);
  if (!r) r = db.prepare('SELECT prev FROM price_logs WHERE stock_code = ? ORDER BY id LIMIT 1').get(code);
  return r ? r.prev : cur;
}

function members(kind, tag) {
  if (kind === '태그' && tag) {
    return db.prepare("SELECT code, cur_price FROM stocks WHERE status = '정상' AND tags = ?").all(tag);
  }
  if (kind === '대장주') {
    return db.prepare("SELECT code, cur_price FROM stocks WHERE status = '정상' AND stock_type = 'bluechip'").all();
  }
  return db.prepare("SELECT code, cur_price FROM stocks WHERE status = '정상'").all();
}

function calcIndex(def) {
  const ms = members(def.kind, def.tag);
  let sum = 0, n = 0;
  for (const s of ms) {
    const open = dayOpen(s.code, s.cur_price);
    if (open > 0) {
      sum += (s.cur_price - open) / open;
      n++;
    }
  }
  const avg = n ? sum / n : 0;
  const value = Math.round(def.base_value * (1 + avg) * 100) / 100;
  return {
    id: def.id,
    name: def.name,
    kind: def.kind,
    tag: def.tag,
    base_value: def.base_value,
    value,
    change_pct: Math.round(avg * 10000) / 100,
    dir: avg > 0 ? 'up' : avg < 0 ? 'down' : 'flat',
    count: n,
  };
}

// GET /api/indices (전체 공개: 정의별 실시간 계산값)
router.get('/', (req, res) => {
  const defs = db.prepare('SELECT * FROM indices ORDER BY id').all();
  res.json(defs.map(calcIndex));
});

module.exports = { router, calcIndex };
