'use strict';

const { Router } = require('express');
const Database = require('better-sqlite3');
const path = require('path');
const { getDb, ok, err } = require('./_helper');


const router = Router();

// GET /api/doctors  从 doctors.db 读取医生列表
router.get('/doctors', (_req, res) => {
  try {
    const doctorsDb = path.join(__dirname, '../../data/hospital.db');
    const db = new Database(doctorsDb, { readonly: true });
    try {
      const rows = db.prepare('SELECT * FROM doctors ORDER BY doctor_code').all();
      db.close();
      ok(res, rows);
    } catch {
      db.close();
      ok(res, []);
    }
  } catch (e) { err(res, e.message, 500); }
});

// GET /api/proxy-sources/groups  可用分组列表
router.get('/proxy-sources/groups', (_req, res) => {
  try {
    const rows = getDb().prepare('SELECT DISTINCT group_name FROM proxies WHERE group_name IS NOT NULL ORDER BY group_name').all();
    ok(res, rows.map(r => r.group_name));
  } catch (e) { err(res, e.message, 500); }
});

module.exports = router;
