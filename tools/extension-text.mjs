import { TextDecoder } from 'node:util';

// Chromium's IsStringUTF8 rejects Unicode noncharacters, even though they are
// structurally valid UTF-8 and accepted by a normal fatal TextDecoder. See:
// https://chromium.googlesource.com/chromium/src/+/main/base/strings/string_util.h
export function assertExtensionText(bytes, filename) {
  let source;
  try { source = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { throw new Error(`${filename}: 非 UTF-8 编码，Chrome 无法加载`); }
  for (const character of source) {
    const cp = character.codePointAt(0);
    if ((cp >= 0xFDD0 && cp <= 0xFDEF) || (cp & 0xFFFE) === 0xFFFE || cp === 0) {
      throw new Error(`${filename}: 包含 Chrome 不接受的字面字符 U+${cp.toString(16).toUpperCase().padStart(4, '0')}，请使用 JavaScript 转义`);
    }
  }
  return source;
}
