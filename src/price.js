const db = require('./db');
const { fillBuy } = require('./routes/trade');
const { isHalted, isPaused, dayOpen, recordKitHit, consumedLevel, KIT_STEP, KIT_HALT_MIN, utcNow } = require('./circuit');

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
// 대장주(bluechip): 변동성 축소 — 노이즈 ±0.2%, 거래영향 ±1% 캡 (일반: ±0.5%, ±3%)

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
  const stocks = db.prepare("SELECT code, name, cur_price, stock_type FROM stocks WHERE status != '정지'").all();
  const upd = db.prepare("UPDATE stocks SET cur_price = ?, updated_at = datetime('now','localtime') WHERE code = ?");
  const log = db.prepare(
    'INSERT INTO price_logs (stock_code, prev, next, cause) VALUES (?,?,?,?)'
  );
  const volumes = recentVolumes(windowSec);
  const priceMap = new Map();
  const tx = db.transaction(() => {
    for (const s of stocks) {
      const { rate: eventRate, frozen } = activeEventRate(s.code, nowIso);
      if (frozen) continue;
      if (isHalted(s.code)) continue; // 서킷브레이커 당일정지: 시세 동결 (예약도 대기 유지)
      if (isPaused(s.code)) continue; // 킷 일시정지 중: 시세 동결
      const isBlue = s.stock_type === 'bluechip';
      const v = volumes.get(s.code) || { buyVol: 0, sellVol: 0 };
      const { tradeImpact } = calcTradeImpact(v.buyVol, v.sellVol);
      // 대장주는 거래영향 ±1% 캡
      const ti = isBlue ? Math.max(-0.01, Math.min(0.01, tradeImpact)) : tradeImpact;
      // 대장주는 노이즈 ±0.2%
      const nr = isBlue ? 0.002 : NOISE_RANGE;
      const noise = Math.random() * (nr * 2) - nr;
      let move = ti + noise + eventRate;
      if (move > TICK_LIMIT) move = TICK_LIMIT;
      if (move < -TICK_LIMIT) move = -TICK_LIMIT;
      const next = Math.max(MIN_PRICE, Math.round(s.cur_price * (1 + move)));
      priceMap.set(s.code, next);
      if (next === s.cur_price) continue;
      upd.run(next, s.code);
      const hasTrade = v.buyVol + v.sellVol > 0;
      const cause = hasTrade && eventRate !== 0 ? 'TRADE_EVENT' : hasTrade ? 'TRADE_NET' : eventRate !== 0 ? 'EVENT' : 'AUTO';
      log.run(s.code, s.cur_price, next, cause);
      checkKit(s, next); // 15% 킷 돌파 시 일시정지 발동
    }
    // 만료된 예약 이벤트 자동 종료 (원복 없음, 로그만)
    db.prepare(
      `UPDATE stock_events SET status = '종료' WHERE status IN ('예약','진행중') AND end_at IS NOT NULL AND end_at < ?`
    ).run(nowIso);
  });
  tx();
  settleReservations(priceMap);
}

// 킷 감시: 확정가(next)가 당일 시가 대비 새 15% 레벨 돌파 → 5분 일시정지 + 속보 공시
// 레벨당 하루 1회만 발동 (재개 후 같은 레벨 머물러도 재발동 안 함)
function checkKit(s, next) {
  const open = dayOpen(s.code, s.cur_price);
  if (!open || open <= 0) return;
  const upLv = Math.floor((next - open) / open / KIT_STEP);
  const downLv = Math.floor((open - next) / open / KIT_STEP);
  let side = null, level = 0;
  if (upLv >= 1 && upLv > consumedLevel(s.code, '상한')) { side = '상한'; level = upLv; }
  else if (downLv >= 1 && downLv > consumedLevel(s.code, '하한')) { side = '하한'; level = downLv; }
  if (!side) return;
  const haltUntil = new Date(Date.now() + KIT_HALT_MIN * 60000).toISOString().slice(0, 19).replace('T', ' ');
  recordKitHit(s.code, side, level, haltUntil);
  const expire = new Date(Date.now() + (KIT_HALT_MIN + 5) * 60000).toISOString().slice(0, 19).replace('T', ' ');
  db.prepare(
    'INSERT INTO notices (scope, stock_code, title, body, pinned, by_admin, expires_at) VALUES (?,?,?,?,0,?,?)'
  ).run(
    '종목',
    s.code,
    `[서킷브레이커] ${s.name} ${side}킷 Lv${level} 발동 ⏸`,
    `당일 시가 대비 ${side === '상한' ? '+' : '-'}${level * 15}% 돌파. 약 ${KIT_HALT_MIN}분간 시세·거래 일시정지 후 자동 재개됩니다.`,
    null,
    expire
  );
  console.log(`[cb] ${s.code} ${side}킷Lv${level} 발동 → ${KIT_HALT_MIN}분 정지`);
}

// 예약매수 체결: 대기건 중 현재가 <= 목표가 → 시장가(fillBuy) 자동 매수, 잔액부족 시 취소
function settleReservations(priceMap) {
  const rows = db.prepare("SELECT * FROM reservations WHERE status = '대기'").all();
  if (!rows.length) return;
  const done = db.prepare("UPDATE reservations SET status = '체결', executed_at = datetime('now','localtime') WHERE id = ?");
  const cancel = db.prepare("UPDATE reservations SET status = '취소', memo = ? WHERE id = ?");
  for (const r of rows) {
    const cur = priceMap.get(r.stock_code);
    if (cur === undefined) continue; // 정지 종목은 대기 유지
    if (cur > r.target_price) continue;
    const res = fillBuy(r.user_id, r.stock_code, r.qty);
    if (res.ok) done.run(r.id);
    else if (res.error === 'CASH_LACK') cancel.run('잔액부족', r.id);
    // 일시정지·당일정지 종목은 priceMap에 없어 여기까지 오지 않음
  }
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
