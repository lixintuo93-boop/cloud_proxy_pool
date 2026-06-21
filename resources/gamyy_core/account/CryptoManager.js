'use strict';

const crypto = require('crypto');

class CryptoManager {
  constructor() {
    this.updateKeyIV();
  }

  updateKeyIV() {
    const d = new Date();
    const year = d.getFullYear();
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    const dateStr = `${year}${month}${day}`;
    this.keyStr = dateStr + '10097@zk';
    this.ivStr  = dateStr + '10097@kz';
  }

  encryptData(plainText) {
    try {
      const key = Buffer.from(this.keyStr, 'latin1');
      const iv  = Buffer.from(this.ivStr,  'latin1');
      const cipher = crypto.createCipheriv('aes-128-cbc', key, iv);
      cipher.setAutoPadding(false);

      let plain = Buffer.from(plainText, 'utf8');
      const pad = 16 - (plain.length % 16);
      if (pad !== 16) plain = Buffer.concat([plain, Buffer.alloc(pad)]);

      const enc = Buffer.concat([cipher.update(plain), cipher.final()]);
      return enc.toString('base64');
    } catch (e) {
      console.error('加密错误:', e.message);
      return null;
    }
  }

  decryptData(cipherText) {
    try {
      const key = Buffer.from(this.keyStr, 'latin1');
      const iv  = Buffer.from(this.ivStr,  'latin1');
      const decipher = crypto.createDecipheriv('aes-128-cbc', key, iv);
      decipher.setAutoPadding(false);

      let dec = Buffer.concat([decipher.update(Buffer.from(cipherText, 'base64')), decipher.final()]);
      let end = dec.length;
      while (end > 0 && dec[end - 1] === 0) end--;
      return dec.slice(0, end).toString('utf8');
    } catch (e) {
      console.error('解密错误:', e.message);
      return null;
    }
  }
}

module.exports = CryptoManager;
