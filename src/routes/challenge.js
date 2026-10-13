const express = require('express');
const db = require('../db');

const router = express.Router();

// 주간 챌린지: 최근 7일 자산 스냅샷(asset_history) 기준 수익률 랭킹
// return = (윈도우 마지막 총자산 - 윈도우 첫 총자산) / 윈도우 첫 총자산
// 스냅샷은 포트폴리오 조회 시 하루 1회 자동 기록됨
function weeklyBoard() {
  const users = db.prepare('SELECT id, nickname, status FROM users').all();
  const rows = [];
  for (const u of users) {
    const snaps = db.prepare(
      `SELECT date, total FROM asset_history
        WHERE user_id = ? AND date >= date('now','+9 hours','-6 days')
        ORDER BY date`
    ).all(u.id);
    if (snaps.length < 2) continue;
    const first = snaps[0].total;
    const last = snaps[snaps.length - 1].total;
    if (!first || first <= 0) continue;
    rows.push({
      user_id: u.id,
      nickname: u.status === '탈퇴' ? '탈퇴회원' : u.nickname,
      start_total: first,
      end_total: last,
      profit: last - first,
      return_pct: Math.round(((last - first) / first) * 10000) / 100,
      days: snaps.length,
    });
  }
  rows.sort((a, b) => b.return_pct - a.return_pct);
  return rows.map((r, i) => ({ rank: i + 1, ...r }));
}

// GET /api/challenges/weekly (공개: 닉네임·수익률만, 금액은 본인만 + 기부왕)
router.get('/weekly', (req, res) => {
  const viewerId = req.session && req.session.userId ? req.session.userId : null;
  const board = weeklyBoard().map((r) => {
    const mine = viewerId === r.user_id;
    const { user_id, start_total, end_total, ...pub } = r;
    return mine ? { ...pub, mine: true, start_total, end_total } : { ...pub, mine: false };
  });
  const myRank = viewerId ? board.findIndex((r) => r.mine) + 1 || null : null;
  let donor = null;
  try {
    donor = require('./badges').calcTitles()['기부왕'] || null;
  } catch (e) { /* 무시 */ }
  res.json({ board, myRank, participants: board.length, donor });
});

module.exports = { router, weeklyBoard };
