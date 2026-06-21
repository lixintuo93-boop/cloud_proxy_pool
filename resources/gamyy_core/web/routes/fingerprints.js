'use strict';

const { Router } = require('express');
const { ok, err } = require('./_helper');
const { FINGERPRINTS, DEFAULT_FINGERPRINT } = require('../../services/fingerprints');

const router = Router();

// GET /api/fingerprints —— 返回 TLS 指纹注册表（供前端代理模板下拉选择）
router.get('/', (_req, res) => {
  try {
    const list = Object.entries(FINGERPRINTS).map(([name, fp]) => ({
      name,
      label:     fp.label || name,
      mode:      fp.mode,
      alpn:      fp.alpn || [],
      ja3:       fp.ja3Hash || null,
      ja4:       fp.ja4 || null,
      source:    fp.source || null,
      isDefault: name === DEFAULT_FINGERPRINT,
    }));
    ok(res, { default: DEFAULT_FINGERPRINT, list });
  } catch (e) { err(res, e.message, 500); }
});

module.exports = router;
