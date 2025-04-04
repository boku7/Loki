import crypto from 'node:crypto';
import util from 'node:util';

function generateAESKey() {
  return {
    key: crypto.randomBytes(32), // 256-bit key
    iv: crypto.randomBytes(12)   // 96-bit IV (recommended for GCM)
  };
}

function generateChaChaKey() {
  return {
    key: crypto.randomBytes(32),  // 256-bit key
    nonce: crypto.randomBytes(12) // 96-bit nonce
  };
}

function aesGcmEncrypt(data, key, iv, aad = null) {
  try {
    if (!data || !key || !iv) {
      throw new Error('Missing required parameters for encryption');
    }

    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);

    if (aad) {
      cipher.setAAD(Buffer.isBuffer(aad) ? aad : Buffer.from(aad));
    }

    let encrypted;
    if (Buffer.isBuffer(data)) {
      encrypted = Buffer.concat([cipher.update(data), cipher.final()]);
    } else {
      encrypted = Buffer.concat([
        cipher.update(Buffer.from(data, 'utf8')),
        cipher.final()
      ]);
    }

    const authTag = cipher.getAuthTag();

    return {
      encrypted,
      authTag
    };
  } catch (error) {
    throw error;
  }
}

function aesGcmDecrypt(encryptedData, key, iv, authTag, aad = null) {
  try {
    if (!encryptedData || !key || !iv || !authTag) {
      throw new Error('Missing required parameters for decryption');
    }

    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(authTag);

    if (aad) {
      decipher.setAAD(Buffer.isBuffer(aad) ? aad : Buffer.from(aad));
    }

    let decrypted;
    if (Buffer.isBuffer(encryptedData)) {
      decrypted = Buffer.concat([decipher.update(encryptedData), decipher.final()]);
    } else {
      decrypted = Buffer.concat([
        decipher.update(Buffer.from(encryptedData, 'hex'), 'hex'),
        decipher.final()
      ]);
    }

    return decrypted;
  } catch (error) {
    throw error;
  }
}

function aesEncrypt(data, key, iv) {
  try {
    if (!data || !key || !iv) {
      throw new Error('Missing required parameters for encryption');
    }

    const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);

    let encrypted;
    if (Buffer.isBuffer(data)) {
      encrypted = Buffer.concat([cipher.update(data), cipher.final()]);
    } else {
      encrypted = cipher.update(data, 'utf8', 'hex');
      encrypted += cipher.final('hex');
    }

    return encrypted;
  } catch (error) {
    throw new Error(`Encryption failed: ${error.message}`);
  }
}

function aesDecrypt(encryptedData, key, iv) {
  try {
    if (!encryptedData || !key || !iv) {
      throw new Error('Missing required parameters for decryption');
    }

    const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);

    let decrypted;
    if (Buffer.isBuffer(encryptedData)) {
      decrypted = Buffer.concat([decipher.update(encryptedData), decipher.final()]);
    } else {
      decrypted = decipher.update(encryptedData, 'hex', 'utf8');
      decrypted += decipher.final('utf8');
    }

    return decrypted;
  } catch (error) {
    throw new Error(`Decryption failed: ${error.message}`);
  }
}

function chaChaPolyEncrypt(data, key, nonce, aad = null) {
  try {
    if (!data || !key || !nonce) {
      throw new Error('Missing required parameters for encryption');
    }

    const dataBuffer = Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8');

    const cipher = crypto.createCipheriv('chacha20-poly1305', key, nonce, {
      authTagLength: 16
    });

    if (aad) {
      cipher.setAAD(Buffer.isBuffer(aad) ? aad : Buffer.from(aad), {
        plaintextLength: dataBuffer.length
      });
    }

    const ciphertext = Buffer.concat([cipher.update(dataBuffer), cipher.final()]);
    const authTag = cipher.getAuthTag();

    return {
      ciphertext,
      authTag
    };
  } catch (error) {
    throw error;
  }
}

function chaChaPolyDecrypt(ciphertext, key, nonce, authTag, aad = null) {
  try {
    if (!ciphertext || !key || !nonce || !authTag) {
      throw new Error('Missing required parameters for decryption');
    }

    const decipher = crypto.createDecipheriv('chacha20-poly1305', key, nonce, {
      authTagLength: 16
    });

    decipher.setAuthTag(authTag);

    if (aad) {
      decipher.setAAD(Buffer.isBuffer(aad) ? aad : Buffer.from(aad), {
        plaintextLength: ciphertext.length
      });
    }

    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch (error) {
    throw error;
  }
}

function generateUUID(len = 10) {
  if (len > 20) len = 20;
  if (len < 1) len = 1;

  const uuid = crypto.randomUUID();
  return uuid.replace(/-/g, '').substring(0, len);
}

function formatEncryptedData(iv, authTag, ciphertext) {
  return Buffer.concat([iv, authTag, ciphertext]);
}

function parseEncryptedData(data, ivLength = 12, tagLength = 16) {
  const iv = data.slice(0, ivLength);
  const authTag = data.slice(ivLength, ivLength + tagLength);
  const ciphertext = data.slice(ivLength + tagLength);

  return { iv, authTag, ciphertext };
}

const pbkdf2Async = util.promisify(crypto.pbkdf2);

async function deriveKey(password, salt = crypto.randomBytes(16), iterations = 100000, keyLength = 32) {
  try {
    const key = await pbkdf2Async(password, salt, iterations, keyLength, 'sha256');
    return { key, salt };
  } catch (error) {
    throw new Error(`Key derivation failed: ${error.message}`);
  }
}
module.exports = {
  aesDecrypt,
  aesEncrypt,
  aesGcmDecrypt,
  aesGcmEncrypt,
  chaChaPolyDecrypt,
  chaChaPolyEncrypt,
  deriveKey,
  formatEncryptedData,
  generateAESKey,
  generateChaChaKey,
  generateUUID,
  parseEncryptedData
}; parseEncryptedData