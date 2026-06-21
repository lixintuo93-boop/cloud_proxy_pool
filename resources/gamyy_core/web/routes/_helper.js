'use strict';

const { getDb } = require('../db/configDb');

function ok(res, data, status = 200) {
  res.status(status).json({ success: true, data });
}

function err(res, message, status = 400) {
  res.status(status).json({ success: false, error: message });
}

function now() {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}

module.exports = { getDb, ok, err, now };
