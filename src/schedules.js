const db = require('./db');
const { kNow } = require('./ktime');

// 경제 캘린더 엔진: 사전 예고 일정이 당일 되면 자동 발표 (시세 이벤트 + 공시)
// - 거시: 전체 시장 일괄 영향 / 실적·공시: 해당 종목(또는 태그) 영향
// - effect 랜덤이면 발표 순간 동전 뒤집기 (사전 포지셔닝이 실력 요소)

const MACRO_TEMPLATES = [
  { title: '한국은행 금리 결정', body: '기준금리 인상 시 성장주 약세·안전자산 강세, 인하 시 반대 흐름이 예상됩니다.' },
  { title: '소비자물가 발표', body: '물가 서프라이즈 시 금리 우려로 시장이 출렁일 수 있습니다.' },
  { title: '고용지표 발표', body: '고용 호조는 소비 기대를, 과열은 긴축 우려를 자극합니다.' },
  { title: 'GDP 속보치 발표', body: '성장률 서프라이즈/쇼크에 따라 전 종목이 함께 움직입니다.' },
];

const EARNING_TITLES = ['분기 실적 발표', '잠정실적 발표'];
const DISCLOSE_TEMPLATES = [
  { dir: -1, title: '유상증자 청약 예정', body: '신주 발행 우려로 단기 조정이 예상됩니다.' },
  { dir: 1, title: '자사주 매입 발표 예정', body: '주주환원 기대로 매수세가 유입될 수 있습니다.' },
  { dir: -1, title: '대주주 지분 매도 예정', body: '오버행 우려로 약세가 예상됩니다.' },
];

function rand(a, b) {
  return Math.random() * (b - a) + a;
}
function randInt(a, b) {
  return Math.floor(rand(a, b + 1));
}
function kAddDays(base, days, h, m) {
  const d = new Date(base.getTime() + days * 86400000);
  const k = new Date(d.getTime() + 9 * 3600000);
  const p = (x) => String(x).padStart(2, '0');
  return `${k.getUTCFullYear()}-${p(k.getUTCMonth() + 1)}-${p(k.getUTCDate())} ${p(h)}:${p(m)}:00`;
}

function upcomingCount() {
  try {
    return db.prepare("SELECT COUNT(*) AS c FROM schedules WHERE status = '예정' AND scheduled_at > ?").get(kNow()).c;
  } catch (e) {
    return 99;
  }
}

// 캘린더가 비지 않게 자동 편성 (예정 3개 미만이면 2~7일 뒤 일정 추가)
function ensureCalendar() {
  if (upcomingCount() >= 3) return;
  try {
    const now = new Date();
    const roll = Math.random();
    if (roll < 0.4) {
      const t = MACRO_TEMPLATES[randInt(0, MACRO_TEMPLATES.length - 1)];
      db.prepare(
        "INSERT INTO schedules (title, kind, scope, body, scheduled_at, effect, magnitude, duration_min) VALUES (?,?,?,?,?,?,?,?)"
      ).run(t.title, '거시', '전체', t.body, kAddDays(now, randInt(2, 7), 11, 0), '랜덤', Math.round(rand(0.04, 0.08) * 100) / 100, randInt(10, 20));
    } else {
      const stocks = db.prepare("SELECT code, name, tags FROM stocks WHERE status = '정상' AND delist_type IS NULL").all();
      if (!stocks.length) return;
      const s = stocks[randInt(0, stocks.length - 1)];
      if (Math.random() < 0.6) {
        const et = EARNING_TITLES[randInt(0, EARNING_TITLES.length - 1)];
        db.prepare(
          "INSERT INTO schedules (title, kind, scope, stock_code, body, scheduled_at, effect, magnitude, duration_min) VALUES (?,?,?,?,?,?,?,?,?)"
        ).run(`${s.name} ${et}`, '실적', '종목', s.code, `${s.name} 실적 발표일입니다. 서프라이즈와 쇼크 중 어느 쪽일까요?`, kAddDays(now, randInt(1, 5), 9, 0), '랜덤', Math.round(rand(0.08, 0.15) * 100) / 100, randInt(5, 15));
      } else {
        const dt = DISCLOSE_TEMPLATES[randInt(0, DISCLOSE_TEMPLATES.length - 1)];
        db.prepare(
          "INSERT INTO schedules (title, kind, scope, stock_code, body, scheduled_at, effect, magnitude, duration_min) VALUES (?,?,?,?,?,?,?,?,?)"
        ).run(`${s.name} ${dt.title}`, '공시', '종목', s.code, dt.body, kAddDays(now, randInt(1, 5), 9, 0), dt.dir > 0 ? '급등' : '급락', Math.round(rand(0.05, 0.12) * 100) / 100, randInt(5, 15));
      }
    }
  } catch (e) {
    console.error('[sched] ensure failed:', e.message);
  }
}

function targetStocks(row) {
  if (row.scope === '종목' && row.stock_code) {
    const s = db.prepare("SELECT code, name FROM stocks WHERE code = ? AND status = '정상' AND delist_type IS NULL").get(row.stock_code);
    return s ? [s] : [];
  }
  if (row.scope === '태그' && row.tag) {
    return db.prepare("SELECT code, name FROM stocks WHERE tags = ? AND status = '정상' AND delist_type IS NULL").all(row.tag);
  }
  return db.prepare("SELECT code, name FROM stocks WHERE status = '정상' AND delist_type IS NULL").all();
}

// 일정 발표: 효과 확정(랜덤이면 동전) → 종목 이벤트 + 공시 → 상태 발표
function fireSchedule(row) {
  const dir = row.effect === '급등' ? 1 : row.effect === '급락' ? -1 : Math.random() < 0.5 ? 1 : -1;
  const type = dir > 0 ? '급등' : '급락';
  const mag = Math.min(0.3, Math.abs(row.magnitude || 0.08));
  const rate = Math.round(dir * mag * 10000) / 10000;
  const mins = Math.min(60, Math.max(1, row.duration_min || 10));
  const now = new Date();
  const start = kNow(now);
  const end = kNow(new Date(now.getTime() + mins * 60000));
  const stocks = targetStocks(row);
  if (!stocks.length) {
    db.prepare("UPDATE schedules SET status = '종료', executed_at = ? WHERE id = ?").run(start, row.id);
    return { id: row.id, skipped: true };
  }
  const tx = db.transaction(() => {
    for (const s of stocks) {
      db.prepare(
        'INSERT INTO stock_events (stock_code, type, rate, status, reason, start_at, end_at) VALUES (?,?,?,?,?,?,?)'
      ).run(s.code, type, rate, '진행중', `[캘린더] ${row.title}`, start, end);
    }
    const arrow = dir > 0 ? '📈' : '📉';
    const scope = row.scope === '전체' ? '전체' : '종목';
    const scode = row.scope === '종목' ? stocks[0].code : null;
    db.prepare(
      'INSERT INTO notices (scope, stock_code, title, body, pinned, by_admin) VALUES (?,?,?,?,0,?)'
    ).run(
      scope,
      scode,
      `[${row.kind}] ${row.title} ${dir > 0 ? '서프라이즈' : '쇼크'} ${arrow}`,
      `${row.body} 결과: ${type} (약 ${mins}분간 영향). 대상: ${row.scope === '전체' ? '전 시장' : stocks.map((x) => x.name).join(', ')}.`,
      null
    );
    db.prepare("UPDATE schedules SET status = '발표', executed_at = ? WHERE id = ?").run(start, row.id);
  });
  try {
    tx();
  } catch (e) {
    console.error('[sched] fire failed:', e.message);
    return null;
  }
  console.log(`[sched] #${row.id} ${row.title} → ${type} ${rate} (${stocks.length}종목)`);
  return { id: row.id, type, rate, mins, codes: stocks.map((s) => s.code) };
}

// 당일 일정 소화 (tick에서 호출). 자동 편성은 하지 않음 (관리자 수동 편성)
function runDueSchedules() {
  let rows = [];
  try {
    rows = db.prepare("SELECT * FROM schedules WHERE status = '예정' AND scheduled_at <= ? ORDER BY scheduled_at LIMIT 5").all(kNow());
  } catch (e) {
    return [];
  }
  return rows.map(fireSchedule).filter(Boolean);
}

module.exports = { ensureCalendar, runDueSchedules, fireSchedule, targetStocks };
