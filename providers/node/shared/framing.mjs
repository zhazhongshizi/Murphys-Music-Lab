// The lexical checks complement JSON Schema, which cannot detect duplicate keys
// or distinguish integer 2 from 2.0 / 2e0. Never put source input in errors.
export const MAX_LINE_BYTES = 1048576;
export function decodeRequest(bytes) {
  if (bytes.length === 0 || bytes.length > MAX_LINE_BYTES) throw new Error('invalid_frame');
  const source = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  const value = JSON.parse(source);
  let i = 0;
  const space = () => { while (/[\x20\t\r\n]/.test(source[i] ?? '\0')) i++; };
  const string = () => {
    const start = i++;
    while (i < source.length) {
      if (source[i++] === '"') return JSON.parse(source.slice(start, i));
      if (source[i - 1] === '\\') i++;
    }
    throw new Error('invalid_frame');
  };
  function walk(depth, rootKey) {
    space();
    const start = i;
    if (source[i] === '{' || source[i] === '[') {
      if (depth >= 128) throw new Error('frame_depth');
      const object = source[i++] === '{';
      const close = object ? '}' : ']';
      const keys = new Set();
      space();
      if (source[i] === close) { i++; return; }
      while (true) {
        space();
        let key;
        if (object) {
          key = string();
          if (keys.has(key)) throw new Error('duplicate_key');
          keys.add(key);
          space(); i++; // colon, already validated by JSON.parse
        }
        walk(depth + 1, depth === 0 ? key : undefined);
        space();
        if (source[i++] === close) break;
      }
    } else if (source[i] === '"') {
      string();
    } else {
      while (i < source.length && !/[\x20\t\r\n,}\]]/.test(source[i])) i++;
      if (!['true', 'false', 'null'].includes(source.slice(start, i)) && !Number.isFinite(Number(source.slice(start, i)))) throw new Error('non_finite_number');
    }
    if (rootKey === 'v' && source.slice(start, i) !== '2') throw new Error('protocol_version_mismatch');
  }
  walk(0);
  if (!value || Array.isArray(value) || typeof value !== 'object'
      || Object.keys(value).sort().join(',') !== 'id,method,params,v'
      || value.v !== 2 || typeof value.id !== 'string'
      || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value.id) || value.id.endsWith('\n')
      || typeof value.method !== 'string' || !value.params || Array.isArray(value.params) || typeof value.params !== 'object') throw new Error('invalid_request');
  return value;
}

export async function* readFrames(stream) {
  let chunks = [], length = 0;
  for await (const chunk of stream) {
    let start = 0;
    while (start < chunk.length) {
      const end = chunk.indexOf(10, start);
      const part = chunk.subarray(start, end === -1 ? chunk.length : end);
      length += part.length;
      if (length > MAX_LINE_BYTES + 1) throw new Error('frame_too_large');
      chunks.push(part);
      if (end === -1) break;
      let line = Buffer.concat(chunks, length);
      if (line.at(-1) === 13) line = line.subarray(0, -1);
      yield decodeRequest(line);
      chunks = []; length = 0; start = end + 1;
    }
  }
  if (length) throw new Error('unterminated_frame');
}
