const db = require('./db');
const { fillBuy } = require('./routes/trade');
const { isHalted, isPaused, dayOpen, recordKitHit, consumedLevel, KIT_STEP, KIT_HALT_MIN } = require('./circuit');
const { kNow, kToday } = require('./ktime');

// 일일 배당: 하루 1회, 배당 설정된 정상 종목 보유자에게 주당 지급
// 인플레 방지: 주당 min(설정액, 현재가의 2%) 상한 · UNIQUE(user,종목,날짜)로 중복 지급 불가
let lastDivDate = null;
function payDividends(today) {
  const stocks = db.prepare("SELECT code, name, cur_price, dividend FROM stocks WHERE status = '정상' AND dividend > 0").all();
  for (const s of stocks) {
    const per = Math.min(s.dividend, Math.floor(s.cur_price * 0.02));
    if (per <= 0) continue;
    const holders = db.prepare('SELECT user_id, qty FROM holdings WHERE stock_code = ? AND qty >= 1').all(s.code);
    if (!holders.length) continue;
    let paid = 0;
    const tx = db.transaction(() => {
      for (const h of holders) {
        const amount = h.qty * per;
        const r = db.prepare(
          'INSERT OR IGNORE INTO dividend_logs (user_id, stock_code, qty, per_share, amount, div_date) VALUES (?,?,?,?,?,?)'
        ).run(h.user_id, s.code, h.qty, per, amount, today);
        if (r.changes > 0) {
          db.prepare('UPDATE accounts SET cash = cash + ? WHERE user_id = ?').run(amount, h.user_id);
          paid++;
        }
      }
    });
    tx();
    if (paid > 0) {
      db.prepare(
        'INSERT INTO notices (scope, stock_code, title, body, pinned, by_admin) VALUES (?,?,?,?,0,?)'
      ).run('종목', s.code, `[배당] ${s.name} 주당 ${per.toLocaleString()}원 지급`, `${today} 배당: ${s.name}(${s.code}) 보유 ${paid}명에게 주당 ${per.toLocaleString()}원 지급 (현재가 대비 상한 2% 적용).`, null);
    }
  }
  lastDivDate = today;
}

// 거래량 연동형 가상시세 (실제 시장 유사):
//   imbalance = (buyVol - sellVol) / totalVol  (-1 ~ +1, 주문흐름 불균형)
//   magnitude = min(1, totalVol / LIQ_BASE)    (유동성 대비 체결강도)
//   tradeImpact = imbalance * magnitude * MAX_TRADE_MOVE  (최대 ±3%/분)
//   noise = 매틱 ±0.5%/√N                     (호가 틱, N=분당 틱 수로 스케일)
//   next = cur * (1 + tradeImpact + noise + event_rate), 틱당 ±10% 클램프(서킷브레이커 유사)
// 틱 간격이 바뀌어도 분당 변동성이 유지되도록 SCALE 보정 (10초틱: 드리프트항 ×1/6, 노이즈 ×1/√6)
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

function tick(intervalMs = 10000) {
  const nowIso = kNow(); // KST
  const today = kToday();
  if (lastDivDate !== today) {
    try {
      payDividends(today);
    } catch (e) {
      console.error('[div] payout failed:', e.message);
    }
  }
  const SCALE = intervalMs / 60000; // 분당 틱 수 보정 (10초 → 1/6)
  const LEADER_PULL = 0.15; // 같은 태그 대장주 등락이 일반주에 미치는 당김 비율 (가볍게)
  const MAX_PULL = 0.005; // 틱당 당김 상한 0.5% (아무리 쏠려도 심하지 않게)
  const stocks = db.prepare("SELECT code, name, cur_price, stock_type, tags, listed_shares FROM stocks WHERE status != '정지'").all();
  const upd = db.prepare("UPDATE stocks SET cur_price = ?, updated_at = datetime('now','localtime') WHERE code = ?");
  const log = db.prepare(
    'INSERT INTO price_logs (stock_code, prev, next, cause) VALUES (?,?,?,?)'
  );
  const volumes = recentVolumes(60); // 최근 60초 체결 압력 (틱 간격과 무관하게 고정)
  const priceMap = new Map();
  const tx = db.transaction(() => {
    // 1패스: 종목별 기본 확정가 계산
    const computed = [];
    for (const s of stocks) {
      const { rate: eventRate, frozen } = activeEventRate(s.code, nowIso);
      if (frozen) continue;
      if (isHalted(s.code)) continue; // 서킷브레이커 당일정지: 시세 동결 (예약도 대기 유지)
      if (isPaused(s.code)) continue; // 킷 일시정지 중: 시세 동결
      const isBlue = s.stock_type === 'bluechip';
      const v = volumes.get(s.code) || { buyVol: 0, sellVol: 0 };
      const { tradeImpact } = calcTradeImpact(v.buyVol, v.sellVol);
      // 대장주는 거래영향 ±1%/분 캡 (일반 ±3%/분), 틱당 SCALE 분할
      const capPerMin = isBlue ? 0.01 : MAX_TRADE_MOVE;
      const ti = Math.max(-capPerMin, Math.min(capPerMin, tradeImpact)) * SCALE;
      // 노이즈: 분당 동일 변동성 유지 (일반 ±0.5%/분, 대장주 ±0.2%/분)
      const nrPerMin = isBlue ? 0.002 : NOISE_RANGE;
      const nr = nrPerMin * Math.sqrt(SCALE);
      const noise = Math.random() * (nr * 2) - nr;
      // 대장주는 이벤트 충격 0.3배 + 이벤트분 분당 ±3% 캡 (우량주답게 눌림)
      let evPart = eventRate * SCALE * (isBlue ? 0.3 : 1);
      if (isBlue) evPart = Math.max(-0.03 * SCALE, Math.min(0.03 * SCALE, evPart));
      let move = ti + noise + evPart;
      if (move > TICK_LIMIT) move = TICK_LIMIT;
      if (move < -TICK_LIMIT) move = -TICK_LIMIT;
      const next = Math.max(MIN_PRICE, Math.round(s.cur_price * (1 + move)));
      const hasTrade = v.buyVol + v.sellVol > 0;
      const cause = hasTrade && eventRate !== 0 ? 'TRADE_EVENT' : hasTrade ? 'TRADE_NET' : eventRate !== 0 ? 'EVENT' : 'AUTO';
      computed.push({ s, next, v, hasTrade, eventRate, cause });
    }
    // 2패스: 같은 태그 대장주의 이번 틱 등락을 일반주에 가볍게 반영 (시총 가중)
    const leadMoves = new Map(); // tag -> [{move, mcap},...]
    for (const c of computed) {
      if (c.s.stock_type === 'bluechip' && c.s.tags && c.s.cur_price > 0) {
        const m = (c.next - c.s.cur_price) / c.s.cur_price;
        const mcap = c.s.cur_price * (c.s.listed_shares || 1000000);
        if (!leadMoves.has(c.s.tags)) leadMoves.set(c.s.tags, []);
        leadMoves.get(c.s.tags).push({ move: m, mcap });
      }
    }
    for (const c of computed) {
      let next = c.next;
      if (c.s.stock_type !== 'bluechip' && c.s.tags && leadMoves.has(c.s.tags)) {
        const arr = leadMoves.get(c.s.tags);
        const tot = arr.reduce((a, b) => a + b.mcap, 0);
        const wavg = tot > 0 ? arr.reduce((a, b) => a + b.move * b.mcap, 0) / tot : 0;
        const pull = Math.max(-MAX_PULL, Math.min(MAX_PULL, wavg * LEADER_PULL));
        next = Math.max(MIN_PRICE, Math.round(c.s.cur_price * (1 + (c.next - c.s.cur_price) / c.s.cur_price + pull)));
      }
      priceMap.set(c.s.code, next);
      if (next === c.s.cur_price) continue;
      upd.run(next, c.s.code);
      log.run(c.s.code, c.s.cur_price, next, c.cause);
      checkKit(c.s, next); // 15% 킷 돌파 시 일시정지 발동
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
  const haltUntil = kNow(new Date(Date.now() + KIT_HALT_MIN * 60000));
  recordKitHit(s.code, side, level, haltUntil);
  const expire = kNow(new Date(Date.now() + (KIT_HALT_MIN + 5) * 60000));
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

function startPriceLoop(intervalMs = 10000) {
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
