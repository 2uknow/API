// src/utils/crypto.js — 암복호화/URL 디코딩 유틸리티
import crypto from 'crypto';
import iconv from 'iconv-lite';

// URL 인코딩된 내용을 디코딩하는 함수
export function decodeUrlEncodedContent(content) {
  if (!content) return '';

  try {
    // 이중 인코딩된 경우도 처리
    let decoded = content;
    let prevDecoded = '';
    let maxIterations = 3; // 무한루프 방지

    while (decoded !== prevDecoded && maxIterations > 0) {
      prevDecoded = decoded;
      try {
        decoded = decodeURIComponent(decoded);
      } catch (e) {
        break; // 더 이상 디코딩 불가
      }
      maxIterations--;
    }

    return decoded;
  } catch (error) {
    // 디코딩 실패 시 원본 반환
    return content;
  }
}

// 다날페이카드 응답 복호화 함수 (AES-256-CBC)
export function decryptDanalCreditResponse(encryptedData) {
  if (!encryptedData) return null;

  try {
    // 다날페이카드 복호화 Key / IV (Hex)
    const keyHex = '20ad459ab1ad2f6e541929d50d24765abb05850094a9629041bebb726814625d';
    const ivHex = 'd7d02c92cb930b661f107cb92690fc83';

    const key = Buffer.from(keyHex, 'hex');
    const iv = Buffer.from(ivHex, 'hex');

    // DATA= 뒤의 암호문 추출
    let cipherText = encryptedData;
    if (encryptedData.includes('DATA=')) {
      cipherText = encryptedData.split('DATA=')[1];
      if (cipherText) {
        cipherText = cipherText.split('&')[0]; // 다른 파라미터가 있으면 제거
      }
    }

    if (!cipherText) return null;

    // URL 디코딩
    cipherText = decodeURIComponent(cipherText);

    // Base64 → Buffer
    const encryptedBuffer = Buffer.from(cipherText, 'base64');

    // AES-256-CBC 복호화
    const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
    let decrypted = decipher.update(encryptedBuffer);
    decrypted = Buffer.concat([decrypted, decipher.final()]);

    const result = decrypted.toString('utf-8');
    console.log('[DECRYPT] 다날페이카드 복호화 성공, length:', result.length);

    return result;
  } catch (error) {
    console.log('[DECRYPT] 다날페이카드 복호화 실패:', error.message);
    return null;
  }
}

// Response Body 처리 함수 (복호화 시도 포함)
export function processResponseBody(responseBody, jobName) {
  if (!responseBody) return '';

  // 다날페이카드 Job인 경우 복호화 시도
  if (jobName && (jobName.includes('다날페이카드') || jobName.includes('CreditRebill'))) {
    if (responseBody.includes('DATA=')) {
      const decrypted = decryptDanalCreditResponse(responseBody);
      if (decrypted) {
        // 복호화된 데이터의 각 값을 URL 디코딩
        return decodeQueryStringValues(decrypted);
      }
    }
  }

  // 기본 URL 디코딩
  return decodeUrlEncodedContent(responseBody);
}

// Query String 형태(KEY=VALUE&KEY2=VALUE2)의 각 VALUE를 URL 디코딩
export function decodeQueryStringValues(queryString) {
  if (!queryString) return '';

  try {
    // & 로 분리하여 각 KEY=VALUE 쌍 처리
    const pairs = queryString.split('&');
    const decodedPairs = pairs.map(pair => {
      const eqIndex = pair.indexOf('=');
      if (eqIndex === -1) return pair;

      const key = pair.substring(0, eqIndex);
      const value = pair.substring(eqIndex + 1);

      // VALUE를 URL 디코딩 (EUC-KR 및 UTF-8 모두 지원)
      let decodedValue = decodeUrlEncodedValue(value);

      return `${key}=${decodedValue}`;
    });

    return decodedPairs.join('&');
  } catch (error) {
    return queryString;
  }
}

// URL 인코딩된 값 디코딩 (EUC-KR, UTF-8 모두 지원)
export function decodeUrlEncodedValue(value) {
  if (!value) return '';

  try {
    // % 인코딩이 없으면 그대로 반환
    if (!value.includes('%')) return value;

    // 1. 먼저 UTF-8로 디코딩 시도
    try {
      const utf8Decoded = decodeURIComponent(value);
      // 성공적으로 디코딩되고 한글이 포함되어 있으면 UTF-8
      if (utf8Decoded !== value && /[\uAC00-\uD7AF]/.test(utf8Decoded)) {
        return utf8Decoded;
      }
    } catch (e) {
      // UTF-8 디코딩 실패 - EUC-KR 시도
    }

    // 2. EUC-KR로 디코딩 시도 (iconv-lite 사용)
    try {
      // %XX 형태를 바이트 배열로 변환
      const bytes = [];
      let i = 0;
      while (i < value.length) {
        if (value[i] === '%' && i + 2 < value.length) {
          const hex = value.substring(i + 1, i + 3);
          const byte = parseInt(hex, 16);
          if (!isNaN(byte)) {
            bytes.push(byte);
            i += 3;
            continue;
          }
        }
        bytes.push(value.charCodeAt(i));
        i++;
      }

      const buffer = Buffer.from(bytes);
      const eucKrDecoded = iconv.decode(buffer, 'euc-kr');

      // EUC-KR 디코딩 결과에 한글이 포함되어 있으면 성공
      if (/[\uAC00-\uD7AF]/.test(eucKrDecoded)) {
        return eucKrDecoded;
      }

      // 한글이 없으면 원본 반환 시도
      return decodeURIComponent(value);
    } catch (e) {
      // EUC-KR 디코딩도 실패
    }

    // 3. 모두 실패하면 원본 반환
    return value;
  } catch (error) {
    return value;
  }
}
