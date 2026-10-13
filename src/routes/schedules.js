const express = require('express');
const db = require('../db');

const router = express.Router();

// GET /api/schedules (전체 공개: 예정 + 최근 발표)
router.get('/', (req, res) => {
  const upcoming = db.prepare("SELECT * FROM schedules WHERE status = '예정' ORDER BY scheduled_at LIMIT 20").all();
  const recent = db.prepare("SELECT * FROM schedules WHERE status = '발표' ORDER BY executed_at DESC LIMIT 10").all();
  res.json({ upcoming, recent });
});

module.exports = { router };
