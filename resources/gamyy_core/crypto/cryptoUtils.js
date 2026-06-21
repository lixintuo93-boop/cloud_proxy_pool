// crypto/cryptoUtils.js
const CryptoJS = require('crypto-js');
const brotli = require('brotli');

class CryptoUtils {
  constructor() {
    const { keyStr, ivStr } = this._generateKeyIv();
    this.keyStr = keyStr;
    this.ivStr = ivStr;
  }

  _generateKeyIv() {
    const now = new Date();
    const formattedDate = now.getFullYear().toString() + 
                         (now.getMonth() + 1).toString().padStart(2, '0') + 
                         now.getDate().toString().padStart(2, '0');
    
    const keyStr = formattedDate + '10097@zk';
    const ivStr = formattedDate + '10097@kz';
    
    return { keyStr, ivStr };
  }

  parseChunkedEncoding(responseBody) {
    try {
      let result = '';
      let position = 0;
      
      while (position < responseBody.length) {
        const chunkSizeEnd = responseBody.indexOf('\r\n', position);
        if (chunkSizeEnd === -1) break;
        
        const chunkSizeLine = responseBody.substring(position, chunkSizeEnd);
        const chunkSize = parseInt(chunkSizeLine, 16);
        
        if (chunkSize === 0) break;
        
        const chunkStart = chunkSizeEnd + 2;
        const chunkEnd = chunkStart + chunkSize;
        
        if (chunkEnd > responseBody.length) break;
        
        const chunkData = responseBody.substring(chunkStart, chunkEnd);
        result += chunkData;
        
        position = chunkEnd + 2;
      }
      
      return result;
    } catch (error) {
      return responseBody;
    }
  }

  extractResponseBody(responseText) {
    try {
      const headerEndIndex = responseText.indexOf('\r\n\r\n');
      if (headerEndIndex === -1) {
        return responseText;
      }
      
      const headersText = responseText.substring(0, headerEndIndex);
      const bodyStartIndex = headerEndIndex + 4;
      let responseBody = responseText.substring(bodyStartIndex);
      
      const transferEncodingMatch = headersText.match(/Transfer-Encoding:\s*(\S+)/i);
      const transferEncoding = transferEncodingMatch ? transferEncodingMatch[1].toLowerCase() : '';
      
      if (transferEncoding === 'chunked') {
        responseBody = this.parseChunkedEncoding(responseBody);
      }
      
      return responseBody;
    } catch (error) {
      return responseText;
    }
  }

  decryptData(cipherText) {
    try {
      if (Buffer.isBuffer(cipherText)) {
        cipherText = cipherText.toString('binary');
      }
      
      let cleanCipherText = cipherText.replace(/\s+/g, '');
      
      const base64Regex = /^[A-Za-z0-9+/]*={0,2}$/;
      if (!base64Regex.test(cleanCipherText)) {
        const binaryBuffer = Buffer.from(cipherText, 'binary');
        cleanCipherText = binaryBuffer.toString('base64');
      }
      
      const key = CryptoJS.enc.Utf8.parse(this.keyStr);
      const iv = CryptoJS.enc.Utf8.parse(this.ivStr);
      
      const encryptedData = CryptoJS.enc.Base64.parse(cleanCipherText);
      
      const decrypted = CryptoJS.AES.decrypt(
        { ciphertext: encryptedData },
        key,
        {
          iv: iv,
          mode: CryptoJS.mode.CBC,
          padding: CryptoJS.pad.ZeroPadding
        }
      );
      
      let result = decrypted.toString(CryptoJS.enc.Utf8);
      result = result.replace(/\0+$/, '');
      
      return result;
    } catch (error) {
      return null;
    }
  }

  processResponse(responseText) {
    try {
      const responseBody = this.extractResponseBody(responseText);
      
      if (!responseBody || responseBody.trim().length === 0) {
        return {
          code: -1,
          error: '响应体为空'
        };
      }
      
      const decryptedData = this.decryptData(responseBody);
      if (!decryptedData) {
        return {
          code: -1,
          error: '解密失败'
        };
      }
      
      return JSON.parse(decryptedData);
      
    } catch (error) {
      return {
        code: -1,
        error: '响应处理失败'
      };
    }
  }

  encryptData(plainText) {
    try {
      const key = CryptoJS.enc.Utf8.parse(this.keyStr);
      const iv = CryptoJS.enc.Utf8.parse(this.ivStr);
      
      const encrypted = CryptoJS.AES.encrypt(plainText, key, {
        iv: iv,
        mode: CryptoJS.mode.CBC,
        padding: CryptoJS.pad.ZeroPadding
      });
      
      return encrypted.toString();
    } catch (error) {
      return null;
    }
  }

  getKeyIvHex() {
    return { 
      keyStr: this.keyStr, 
      ivStr: this.ivStr
    };
  }
}

module.exports = CryptoUtils;