/**
 * 자식 프로세스 stdout/stderr 라인 처리 헬퍼
 *
 * binary-runner / newman-runner 가 각자 작성하던
 * "iconv 디코드 → 파일 write → 누적 → 라인 split → broadcastLog" 패턴을
 * 한 곳으로 모은다. 인코딩만 옵션으로 갈아 끼우면 된다.
 */

import iconv from 'iconv-lite';

// ANSI 이스케이프 시퀀스 (SGR 색상, 커서 이동 등) 제거용
// Newman CLI 가 터미널용 색상 코드를 출력하면 파일에선 [33m[90m... 같은 노이즈로 보인다
const ANSI_REGEX = /[][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-PRZcf-nqry=><]/g;

export function stripAnsi(s) {
  return typeof s === 'string' ? s.replace(ANSI_REGEX, '') : s;
}

/**
 * Buffer 를 지정 인코딩으로 디코드한다. 실패 시 기본 toString 으로 폴백.
 *
 * encoding 값:
 *   - 'utf8'          : 항상 UTF-8
 *   - 'cp949'         : 항상 CP949
 *   - 'auto-windows'  : Windows 에서만 CP949, 그 외 UTF-8 (SClient 한글 출력용)
 */
export function decodeChunk(buf, encoding) {
  try {
    if (encoding === 'auto-windows') {
      return process.platform === 'win32'
        ? iconv.decode(buf, 'cp949')
        : buf.toString('utf8');
    }
    if (encoding === 'cp949') return iconv.decode(buf, 'cp949');
    if (encoding === 'utf8') return buf.toString('utf8');
    throw new Error(`Unknown encoding: ${encoding}`);
  } catch (_) {
    return buf.toString();
  }
}

/**
 * proc.stdout / proc.stderr 같은 Readable 스트림에 라인 단위 핸들러를 연결한다.
 *
 * @param {import('stream').Readable} stream
 * @param {object} opts
 * @param {string} opts.encoding             - 'utf8' | 'cp949' | 'auto-windows'
 * @param {import('stream').Writable} [opts.fileStream] - 디코드한 chunk 를 그대로 기록할 파일 스트림
 * @param {boolean} [opts.stripAnsiForFile]  - true 면 fileStream 에 쓸 때 ANSI 이스케이프 제거 (라이브 로그 색상은 유지)
 * @param {(chunk: string) => void} [opts.onChunk]      - 디코드 직후 chunk 전체에 대한 콜백 (누적/디버그용)
 * @param {(line: string) => void} [opts.onLine]        - 비어있지 않은 라인 단위 콜백
 */
export function attachLineProcessor(stream, { encoding, fileStream, stripAnsiForFile, onChunk, onLine }) {
  // 청크 경계에서 한 라인이 둘로 쪼개지지 않도록 미종결 꼬리를 다음 청크와 이어붙인다
  let leftover = '';
  stream.on('data', (buf) => {
    const s = decodeChunk(buf, encoding);
    if (fileStream) fileStream.write(stripAnsiForFile ? stripAnsi(s) : s);
    if (onChunk) onChunk(s);
    if (onLine) {
      const parts = (leftover + s).split(/\r?\n/);
      leftover = parts.pop();
      for (const line of parts) {
        if (line) onLine(line);
      }
    }
  });
  stream.on('end', () => {
    if (onLine && leftover) onLine(leftover);
    leftover = '';
  });
}
