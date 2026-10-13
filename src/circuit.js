const db = require('./db');
const { kNow, kToday } = require('./ktime');

// 서킷브레이커 상수: 15%마다 킷 → 5분 일시정지, 당일 ±60% 도달 시 당일 거래정지
const KIT_STEP = 0.15;
const KIT_HALT_MIN = 5;
const DAY_LIMIT = 0.6;

function utcNow() {
  return kNow(); // KST (기존명 유지, 내용은 KST)
}
function localDate() {
  return kToday(); // KST (기존명 유지, 내용은 KST)
}

// 서킷브레이커 기준가: 당일 시가 (오늘 첫 시세로그 prev → 없으면 전체 첫 로그 → 없으면 현재가)
function dayOpen(code, cur) {
  let r = db.prepare(
    "SELECT prev FROM price_logs WHERE stock_code = ? AND date(created_at) = date('now','localtime') ORDER BY id LIMIT 1"
  ).get(code);
  if (!r) r = db.prepare('SELECT prev FROM price_logs WHERE stock_code = ? ORDER BY id LIMIT 1').get(code);
  return r ? r.prev : cur;
}

// 당일 고/저 (오늘 로그 기준, 없으면 기준가로)
function dayRange(code, open, cur) {
  const r = db.prepare(
    `SELECT MIN(next) AS mn, MAX(next) AS mx FROM price_logs
      WHERE stock_code = ? AND date(created_at) = date('now','localtime')`
  ).get(code);
  if (!r || r.mn == null) return { high: Math.max(open, cur), low: Math.min(open, cur) };
  return { high: Math.max(r.mx, cur, open), low: Math.min(r.mn, cur, open) };
}

// 15%마다 킷 카운트, ±60% 도달 시 당일 거래정지 (다음 날 day_open 갱신으로 자동 해제)
function circuitState(code) {
  const s = db.prepare('SELECT cur_price, status FROM stocks WHERE code = ?').get(code);
  if (!s) return null;
  const open = dayOpen(code, s.cur_price);
  const { high, low } = dayRange(code, open, s.cur_price);
  const upMove = open > 0 ? (high - open) / open : 0;
  const downMove = open > 0 ? (open - low) / open : 0;
  const upKits = Math.floor(upMove / KIT_STEP);
  const downKits = Math.floor(downMove / KIT_STEP);
  const halted = upMove >= DAY_LIMIT || downMove >= DAY_LIMIT;
  const pause = pausedState(code);
  return {
    open,
    high,
    low,
    move_pct: open > 0 ? Math.round(((s.cur_price - open) / open) * 10000) / 100 : 0,
    up_kits: upKits,
    down_kits: downKits,
    halted,
    halt_side: upMove >= DAY_LIMIT ? '상한' : downMove >= DAY_LIMIT ? '하한' : null,
    paused: pause.paused,
    resume_at: pause.resume_at,
  };
}

// 일시정지 상태: 오늘 발동된 킷 중 halt_until이 아직 안 지난 게 있으면 정지 중
function pausedState(code) {
  const row = db.prepare(
    `SELECT MAX(halt_until) AS hu FROM cb_hits WHERE stock_code = ? AND date = ?`
  ).get(code, localDate());
  if (row && row.hu && row.hu > utcNow()) return { paused: true, resume_at: row.hu };
  return { paused: false, resume_at: null };
}

function isHalted(code) {
  const st = circuitState(code);
  return st ? st.halted : false;
}

function isPaused(code) {
  return pausedState(code).paused;
}

// 킷 발동 기록 (멱등: 같은 날짜·방향·레벨 중복 무시)
function recordKitHit(code, side, level, haltUntil) {
  db.prepare(
    'INSERT OR IGNORE INTO cb_hits (stock_code, date, side, level, halt_until) VALUES (?,?,?,?,?)'
  ).run(code, localDate(), side, level, haltUntil);
}

function consumedLevel(code, side) {
  const r = db.prepare(
    'SELECT MAX(level) AS m FROM cb_hits WHERE stock_code = ? AND date = ? AND side = ?'
  ).get(code, localDate(), side);
  return (r && r.m) || 0;
}

module.exports = { dayOpen, dayRange, circuitState, isHalted, isPaused, recordKitHit, consumedLevel, KIT_STEP, KIT_HALT_MIN, DAY_LIMIT, utcNow, localDate };
