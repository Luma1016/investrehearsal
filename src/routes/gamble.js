const express = require('express');
const db = require('../db');
const { requireLogin } = require('../middleware');

const router = express.Router();

function isHaltedAll() {
  try {
    const r = db.prepare("SELECT value FROM settings WHERE key = 'gamble_halted'").get();
    return r && r.value === '1';
  } catch (e) {
    return false;
  }
}

// GET /api/gamble/games (공개: 활성화된 게임 목록 + 환수율 표시용)
router.get('/games', (req, res) => {
  const rows = db.prepare('SELECT code, name, payout_mult, win_prob, min_bet, enabled, descrip FROM games ORDER BY code').all();
  res.json(rows.map((g) => ({ ...g, rtp: Math.round(g.payout_mult * g.win_prob * 1000) / 10 })));
});

// GET /api/gamble/my (내 전적, 로그인)
router.get('/my', requireLogin, (req, res) => {
  const r = db.prepare(
    'SELECT COUNT(*) AS plays, COALESCE(SUM(bet),0) AS bet, COALESCE(SUM(payout),0) AS payout, COALESCE(SUM(win),0) AS wins FROM gambles WHERE user_id = ?'
  ).get(req.user.id);
  res.json(r);
});

// POST /api/gamble/play {game, bet, choice?} (하우스가 항상 유리: mult*prob < 1)
router.post('/play', requireLogin, (req, res) => {
  if (isHaltedAll()) return res.status(403).json({ error: 'GAMBLE_HALTED' });
  const { game, bet, choice } = req.body || {};
  const g = db.prepare('SELECT * FROM games WHERE code = ?').get(game);
  if (!g || !g.enabled) return res.status(404).json({ error: 'NOT_FOUND' });
  if (g.code === 'crash') return res.status(400).json({ error: 'USE_CRASH_PANEL' });
  const b = Math.floor(Number(bet));
  if (!Number.isInteger(b) || b < g.min_bet) return res.status(400).json({ error: 'INVALID_BET' });
  const acc = db.prepare('SELECT cash FROM accounts WHERE user_id = ?').get(req.user.id);
  if (!acc || acc.cash < b) return res.status(400).json({ error: 'CASH_LACK' });
  let win = false;
  let detail = '';
  if (g.code === 'dice') {
    const pick = Number(choice);
    if (!Number.isInteger(pick) || pick < 1 || pick > 6) return res.status(400).json({ error: 'INVALID_CHOICE' });
    const roll = 1 + Math.floor(Math.random() * 6);
    win = roll === pick;
    detail = `${pick} 선택 · 주사위 ${roll}`;
  } else {
    // coin 및 기타: choice 무시 없이 홀/짝 판정 (choice 없으면 랜덤 선택으로 간주)
    const pick = choice === '짝' ? '짝' : '홀';
    const roll = Math.random() < 0.5 ? '홀' : '짝';
    win = roll === pick;
    detail = `${pick} 선택 · 결과 ${roll}`;
  }
  const payout = win ? Math.floor(b * g.payout_mult) : 0;
  const tx = db.transaction(() => {
    db.prepare('UPDATE accounts SET cash = cash - ? WHERE user_id = ?').run(b, req.user.id);
    if (payout > 0) db.prepare('UPDATE accounts SET cash = cash + ? WHERE user_id = ?').run(payout, req.user.id);
    db.prepare('INSERT INTO gambles (user_id, game_code, bet, payout, win) VALUES (?,?,?,?,?)')
      .run(req.user.id, g.code, b, payout, win ? 1 : 0);
  });
  tx();
  const cash = db.prepare('SELECT cash FROM accounts WHERE user_id = ?').get(req.user.id).cash;
  res.status(201).json({ ok: true, win, bet: b, payout, cash, detail });
});

// POST /api/gamble/crash/start {bet, target} (목표 단계 크래시: 즉시 정산, 클라는 연출만)
// - 시작 검증: 잔액 < 베팅금 × 목표단계 → 차단 (최대 -n배 감당 불가)
// - n단계 누적 배율(±n 클램프)로 net 정산: 양수면 +bet×m, 음수면 -bet×|m|
// - 단계별 변동폭은 목표가 클수록 커지고, 하우스 우위(승률 약 45%) 파라미터 적용
router.post('/crash/start', requireLogin, (req, res) => {
  if (isHaltedAll()) return res.status(403).json({ error: 'GAMBLE_HALTED' });
  const g = db.prepare("SELECT * FROM games WHERE code = 'crash'").get();
  if (!g || !g.enabled) return res.status(404).json({ error: 'NOT_FOUND' });
  const bet = Math.floor(Number(req.body && req.body.bet));
  const n = Math.floor(Number(req.body && req.body.target));
  const maxN = Math.min(20, Math.max(1, g.max_n || 10));
  const pUp = g.p_up != null ? g.p_up : 0.48;
  const rUp = g.rng_up != null ? g.rng_up : 1.0;
  const rDown = g.rng_down != null ? g.rng_down : 1.1;
  if (!Number.isInteger(bet) || bet < g.min_bet) return res.status(400).json({ error: 'INVALID_BET' });
  if (!Number.isInteger(n) || n < 1 || n > maxN) return res.status(400).json({ error: 'INVALID_TARGET' });
  const acc = db.prepare('SELECT cash FROM accounts WHERE user_id = ?').get(req.user.id);
  const cash = acc ? acc.cash : 0;
  if (cash < bet * n) {
    return res.status(400).json({ error: 'INSUFFICIENT_MAXLOSS', need: bet * n, cash });
  }
  const vol = 1 + n / 10; // 목표 단계가 높을수록 변동성 증가
  const steps = [];
  let pos = 0;
  for (let i = 0; i < n; i++) {
    const up = Math.random() < pUp;
    const mag = up
      ? 0.1 + Math.random() * (1.0 * rUp - 0.1)
      : -(0.1 + Math.random() * (1.0 * rDown - 0.1));
    const mv = Math.round(mag * vol * 100) / 100;
    pos = Math.round((pos + mv) * 100) / 100;
    steps.push({ step: i + 1, move: mv, pos: Math.round(pos * 100) / 100, up });
  }
  let final = Math.round(pos * 100) / 100;
  if (final > n) final = n;
  if (final < -n) final = -n;
  const net = Math.round(bet * final);
  const tx = db.transaction(() => {
    if (net !== 0) db.prepare('UPDATE accounts SET cash = cash + ? WHERE user_id = ?').run(net, req.user.id);
    db.prepare('INSERT INTO gambles (user_id, game_code, bet, payout, win) VALUES (?,?,?,?,?)')
      .run(req.user.id, 'crash', bet, net, final > 0 ? 1 : 0);
  });
  tx();
  const cashAfter = db.prepare('SELECT cash FROM accounts WHERE user_id = ?').get(req.user.id).cash;
  res.status(201).json({ ok: true, bet, target: n, steps, final, win: final > 0, net, cash: cashAfter });
});

// GET /api/gamble/my/recent (내 도박 로그 50, 스크롤용)
router.get('/my/recent', requireLogin, (req, res) => {
  const rows = db.prepare(
    'SELECT g.game_code, g.bet, g.payout, g.win, g.created_at FROM gambles g WHERE g.user_id = ? ORDER BY g.id DESC LIMIT 50'
  ).all(req.user.id);
  const total = db.prepare(
    `SELECT COALESCE(SUM(CASE WHEN game_code = 'crash' THEN payout ELSE payout - bet END),0) AS net,
       COUNT(*) AS plays FROM gambles WHERE user_id = ?`
  ).get(req.user.id);
  res.json({ rows, net: total.net, plays: total.plays });
});
router.get('/recent', (req, res) => {
  res.json(db.prepare(
    'SELECT g.game_code, g.bet, g.payout, g.win, g.created_at, u.nickname FROM gambles g LEFT JOIN users u ON u.id = g.user_id ORDER BY g.id DESC LIMIT 20'
  ).all().map((r) => ({ ...r, nickname: (r.nickname || '익명').slice(0, 8) })));
});

module.exports = { router };
