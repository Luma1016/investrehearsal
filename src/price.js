const db = require('./db');

// 거래량 연동형 가상시세 (실제 시장 유사):
//   imbalance = (buyVol - sellVol) / totalVol  (-1 ~ +1, 주문흐름 불균형)
//   magnitude = min(1, totalVol / LIQ_BASE)    (유동성 대비 체결강도)
//   tradeImpact = imbalance * magnitude * MAX_TRADE_MOVE  (최대 ±3%/tick)
//   noise = rand(-0.005 ~ +0.005)             (호가 틱/마켓메이커 호가, 거래 없을 때도 미세 변동)
//   next = cur * (1 + tradeImpact + noise + event_rate), tick당 ±10% 클램프(서킷브레이커 유사)
const LIQ_BASE = 500;
const MAX_TRADE_MOVE = 0.03;
const NOISE_RANGE = 0.005;
const TICK_LIMIT = 0.1;
const MIN_PRICE = 100;

// 가상시세: next = cur * (1 + rand(-0.02~0.02) + event_rate), 정지 제외
function activeEventRate(code, nowIso) {
  const rows = db.prepare(
    `SELECT type, rate FROM stock_events
     WHERE stock_code = ?
       AND (status = '진행중'
         OR (status = '예약' AND (start_at IS NULL OR start_at <= ?) AND (end_at IS NULL OR end_at >= ?)))`
  ).all(code, nowIso, nowIso);
  let rate = 0;
  let frozen = false;
  for (const r of rows) {
    if (r.type === '정지') frozen = true;
    else rate += Number(r.rate) || 0;
  }
  return { rate, frozen };
}

// 최근 windowSec 동안의 종목별 매수/매도 체결수량 집계 (거래량 연동용)
function recentVolumes(windowSec) {
  const rows = db.prepare(
    `SELECT stock_code,
       COALESCE(SUM(CASE WHEN side = 'BUY' THEN qty ELSE 0 END), 0) AS buyVol,
       COALESCE(SUM(CASE WHEN side = 'SELL' THEN qty ELSE 0 END), 0) AS sellVol
     FROM transactions
     WHERE created_at >= datetime('now','localtime', ?)
     GROUP BY stock_code`
  ).all(`-${windowSec} seconds`);
  const map = new Map();
  for (const r of rows) map.set(r.stock_code, { buyVol: r.buyVol, sellVol: r.sellVol });
  return map;
}

function calcTradeImpact(buyVol, sellVol) {
  const total = buyVol + sellVol;
  if (total <= 0) return { tradeImpact: 0, imbalance: 0, total };
  const imbalance = (buyVol - sellVol) / total;
  const magnitude = Math.min(1, total / LIQ_BASE);
  return { tradeImpact: imbalance * magnitude * MAX_TRADE_MOVE, imbalance, total };
}

function tick(intervalMs = 60000) {
  const now = new Date();
  const nowIso = now.toISOString().slice(0, 19).replace('T', ' ');
  const windowSec = Math.max(10, Math.round(intervalMs / 1000));
  const stocks = db.prepare("SELECT code, cur_price FROM stocks WHERE status != '정지'").all();
  const upd = db.prepare("UPDATE stocks SET cur_price = ?, updated_at = datetime('now','localtime') WHERE code = ?");
  const log = db.prepare(
    'INSERT INTO price_logs (stock_code, prev, next, cause) VALUES (?,?,?,?)'
  );
  const volumes = recentVolumes(windowSec);
  const tx = db.transaction(() => {
    for (const s of stocks) {
      const { rate: eventRate, frozen } = activeEventRate(s.code, nowIso);
      if (frozen) continue;
      const v = volumes.get(s.code) || { buyVol: 0, sellVol: 0 };
      const { tradeImpact } = calcTradeImpact(v.buyVol, v.sellVol);
      const noise = Math.random() * (NOISE_RANGE * 2) - NOISE_RANGE;
      let move = tradeImpact + noise + eventRate;
      if (move > TICK_LIMIT) move = TICK_LIMIT;
      if (move < -TICK_LIMIT) move = -TICK_LIMIT;
      const next = Math.max(MIN_PRICE, Math.round(s.cur_price * (1 + move)));
      if (next === s.cur_price) continue;
      upd.run(next, s.code);
      const hasTrade = v.buyVol + v.sellVol > 0;
      const cause = hasTrade && eventRate !== 0 ? 'TRADE_EVENT' : hasTrade ? 'TRADE_NET' : eventRate !== 0 ? 'EVENT' : 'AUTO';
      log.run(s.code, s.cur_price, next, cause);
    }
    // 만료된 예약 이벤트 자동 종료 (원복 없음, 로그만)
    db.prepare(
      `UPDATE stock_events SET status = '종료' WHERE status IN ('예약','진행중') AND end_at IS NOT NULL AND end_at < ?`
    ).run(nowIso);
  });
  tx();
}

function startPriceLoop(intervalMs = 60000) {
  const t = setInterval(() => {
    try {
      tick(intervalMs);
    } catch (e) {
      console.error('[price] tick failed:', e.message);
    }
  }, intervalMs);
  if (t.unref) t.unref();
  return t;
}

module.exports = { tick, startPriceLoop, activeEventRate, recentVolumes, calcTradeImpact };
