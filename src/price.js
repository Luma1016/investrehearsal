const db = require('./db');
const { fillBuy } = require('./routes/trade');
const { isHalted, isPaused, dayOpen, recordKitHit, consumedLevel, KIT_STEP, KIT_HALT_MIN } = require('./circuit');
const { kNow, kToday } = require('./ktime');

// 상장폐지/인수합병 정기 점검: 하루 1회, 현재가 < 기준(기본 1000원) 종목 처리
// - 같은 태그 정상 대장주 있으면 인수합병 시도: 낮은 확률(기본 25%)로 성사, 실패 시 당장 유지(다음 점검 재도전, 그 사이 반등하면 생존)
// - 인수자가 없으면 즉시 상장폐지(최종가 전량 현금화)
const MA_CHANCE = 0.25;
let lastDelistDate = null;
function delistThreshold() {
  try {
    const r = db.prepare("SELECT value FROM settings WHERE key = 'delist_price'").get();
    const v = Math.floor(Number(r && r.value));
    if (Number.isInteger(v) && v >= 100) return v;
  } catch (e) { /* 무시 */ }
  return 1000;
}
function checkDelistings() {
  const th = delistThreshold();
  const targets = db.prepare(
    "SELECT * FROM stocks WHERE status = '정상' AND delist_type IS NULL AND cur_price < ?"
  ).all(th);
  for (const t of targets) {
    const acq = db.prepare(
      `SELECT * FROM stocks WHERE status = '정상' AND delist_type IS NULL AND stock_type = 'bluechip'
        AND tags = ? AND code != ? ORDER BY cur_price * listed_shares DESC LIMIT 1`
    ).get(t.tags, t.code);
    if (acq && acq.cur_price > 0) {
      if (Math.random() < MA_CHANCE) mergeStock(t, acq);
      else console.log(`[m&a] ${t.code} 인수 불발 (다음 점검에 재도전)`);
    } else delistStock(t, th);
  }
  lastDelistDate = kToday();
}
function cancelReservations(code, memo) {
  db.prepare("UPDATE reservations SET status = '취소', memo = ? WHERE stock_code = ? AND status = '대기'").run(memo, code);
}
function mergeStock(t, acq) {
  const ratio = t.cur_price / acq.cur_price;
  const holders = db.prepare('SELECT user_id, qty, avg_price FROM holdings WHERE stock_code = ?').all(t.code);
  const tx = db.transaction(() => {
    for (const h of holders) {
      const raw = h.qty * ratio;
      const nq = Math.floor(raw);
      let costBasis = 0;
      if (nq > 0) {
        costBasis = Math.round((h.qty * t.cur_price) / nq);
        const ex = db.prepare('SELECT qty, avg_price FROM holdings WHERE user_id = ? AND stock_code = ?').get(h.user_id, acq.code);
        if (ex) {
          const tq = ex.qty + nq;
          const ta = Math.round((ex.avg_price * ex.qty + costBasis * nq) / tq);
          db.prepare('UPDATE holdings SET qty = ?, avg_price = ? WHERE user_id = ? AND stock_code = ?').run(tq, ta, h.user_id, acq.code);
        } else {
          db.prepare('INSERT INTO holdings (user_id, stock_code, qty, avg_price) VALUES (?,?,?,?)').run(h.user_id, acq.code, nq, costBasis);
        }
      }
      const give = nq > 0 ? Math.max(0, h.qty * t.cur_price - nq * costBasis) : h.qty * t.cur_price;
      if (give > 0) db.prepare('UPDATE accounts SET cash = cash + ? WHERE user_id = ?').run(give, h.user_id);
      db.prepare('DELETE FROM holdings WHERE user_id = ? AND stock_code = ?').run(h.user_id, t.code);
    }
    db.prepare("UPDATE stocks SET status = '정지', delist_type = '인수합병', delisted_at = datetime('now','localtime') WHERE code = ?").run(t.code);
  });
  tx();
  cancelReservations(t.code, '인수합병');
  db.prepare(
    'INSERT INTO notices (scope, stock_code, title, body, pinned, by_admin) VALUES (?,?,?,?,0,?)'
  ).run('종목', acq.code, `[인수합병] ${acq.name} → ${t.name} 인수`, `${t.name}(${t.code}, 최종 ${t.cur_price}원)이 ${acq.name}(${acq.code})에 인수됐습니다. 보유 주식은 ${ratio.toFixed(4)} 비율로 교환되고 나머지는 현금 지급됐습니다.`, null);
  console.log(`[m&a] ${t.code} → ${acq.code} x${ratio.toFixed(4)} (${holders.length}명)`);
}
function delistStock(t, th) {
  const holders = db.prepare('SELECT user_id, qty FROM holdings WHERE stock_code = ?').all(t.code);
  const tx = db.transaction(() => {
    for (const h of holders) {
      db.prepare('UPDATE accounts SET cash = cash + ? WHERE user_id = ?').run(h.qty * t.cur_price, h.user_id);
      db.prepare('DELETE FROM holdings WHERE user_id = ? AND stock_code = ?').run(h.user_id, t.code);
    }
    db.prepare("UPDATE stocks SET status = '정지', delist_type = '상장폐지', delisted_at = datetime('now','localtime') WHERE code = ?").run(t.code);
  });
  tx();
  cancelReservations(t.code, '상장폐지');
  db.prepare(
    'INSERT INTO notices (scope, stock_code, title, body, pinned, by_admin) VALUES (?,?,?,?,0,?)'
  ).run('종목', t.code, `[상장폐지] ${t.name} (${t.code})`, `주가가 폐지 기준(${th.toLocaleString()}원)을 밑돌아 상장폐지됐습니다. 보유 주식은 최종가(${t.cur_price.toLocaleString()}원)로 전량 현금화됐습니다.`, null);
  console.log(`[delist] ${t.code} 폐지 (${holders.length}명 현금화)`);
}

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
//   imbalance = (매수대금-매도대금)/전체대금 (돈의 방향)
//   magnitude = min(1, 전체대금 / LIQ_VALUE)  (유동성 대비 체결강도)
//   LIQ_VALUE = max(5천만원, 시총×0.1%) — 천만원 수준은 미풍, 억 단위부터 의미 있게
//   tradeImpact = imbalance * magnitude * MAX_TRADE_MOVE  (최대 ±3%/분)
//   noise = 매틱 ±0.5%/√N                     (호가 틱, N=분당 틱 수로 스케일)
//   next = cur * (1 + tradeImpact + noise + event_rate), 틱당 ±10% 클램프(서킷브레이커 유사)
// 틱 간격이 바뀌어도 분당 변동성이 유지되도록 SCALE 보정 (10초틱: 드리프트항 ×1/6, 노이즈 ×1/√6)
const LIQ_BASE_WON = 50000000;
const LIQ_MCAP_RATIO = 0.001;
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

// 최근 windowSec 동안의 종목별 매수/매도 체결수량·대금 집계 (거래량 연동용)
function recentVolumes(windowSec) {
  const rows = db.prepare(
    `SELECT stock_code,
       COALESCE(SUM(CASE WHEN side = 'BUY' THEN qty ELSE 0 END), 0) AS buyVol,
       COALESCE(SUM(CASE WHEN side = 'SELL' THEN qty ELSE 0 END), 0) AS sellVol,
       COALESCE(SUM(CASE WHEN side = 'BUY' THEN qty * price ELSE 0 END), 0) AS buyTurn,
       COALESCE(SUM(CASE WHEN side = 'SELL' THEN qty * price ELSE 0 END), 0) AS sellTurn
     FROM transactions
     WHERE via = 'MARKET' AND created_at >= datetime('now','localtime', ?)
     GROUP BY stock_code`
  ).all(`-${windowSec} seconds`);
  const map = new Map();
  for (const r of rows) map.set(r.stock_code, { buyVol: r.buyVol, sellVol: r.sellVol, buyTurn: r.buyTurn, sellTurn: r.sellTurn });
  return map;
}

function calcTradeImpact(buyVol, sellVol, buyTurn, sellTurn, liqValue) {
  const totalTurn = (buyTurn || 0) + (sellTurn || 0);
  if (totalTurn <= 0) return { tradeImpact: 0, imbalance: 0, total: (buyVol || 0) + (sellVol || 0) };
  const imbalance = ((buyTurn || 0) - (sellTurn || 0)) / totalTurn;
  const magnitude = Math.min(1, totalTurn / Math.max(1, liqValue));
  return { tradeImpact: imbalance * magnitude * MAX_TRADE_MOVE, imbalance, total: (buyVol || 0) + (sellVol || 0) };
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
  if (lastDelistDate !== today) {
    try {
      checkDelistings();
    } catch (e) {
      console.error('[delist] check failed:', e.message);
    }
  }
  try {
    require('./schedules').runDueSchedules(); // 경제 캘린더 당일 일정 발표
  } catch (e) {
    console.error('[sched] run failed:', e.message);
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
      const v = volumes.get(s.code) || { buyVol: 0, sellVol: 0, buyTurn: 0, sellTurn: 0 };
      const mcap = s.cur_price * (s.listed_shares || 1000000);
      const liqValue = Math.max(LIQ_BASE_WON, mcap * LIQ_MCAP_RATIO);
      const { tradeImpact } = calcTradeImpact(v.buyVol, v.sellVol, v.buyTurn, v.sellTurn, liqValue);
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

module.exports = { tick, startPriceLoop, activeEventRate, recentVolumes, calcTradeImpact, checkDelistings, delistThreshold, mergeStock, delistStock };
