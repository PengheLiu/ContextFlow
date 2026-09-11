// 图文记录里的图片只保存引用，二进制由浏览器 / 本地服务的附件库单独托管。
// 自定义 scheme 永远不直接交给浏览器导航；预览与同步前必须显式解析。

export const ASSET_SCHEME = 'contextflow-asset:';
export const ASSET_ID_RE = /^[a-f0-9]{64}$/;
export const ASSET_TOKEN_RE = /!\[([^\]\n]*)\]\(contextflow-asset:([a-f0-9]{64})\)/g;
export const ALLOWED_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp']);
export const MAX_ASSET_BYTES = 8 * 1024 * 1024;

const cleanAlt = (value) => String(value || '图片').replace(/[\[\]\r\n]/g, ' ').trim() || '图片';

export function assetToken(id, alt = '图片') {
  if (!ASSET_ID_RE.test(String(id))) throw new Error('附件 id 无效');
  return `![${cleanAlt(alt)}](${ASSET_SCHEME}${id})`;
}

export function assetIds(source) {
  const out = [];
  for (const match of String(source || '').matchAll(new RegExp(ASSET_TOKEN_RE.source, 'g'))) {
    if (!out.includes(match[2])) out.push(match[2]);
  }
  return out;
}

/** 把文本拆成可编辑文字块与不可拆的图片块，拼回去必须逐字等于原值。 */
export function splitAssetDocument(source) {
  const value = String(source || '');
  const blocks = [];
  let at = 0;
  for (const match of value.matchAll(new RegExp(ASSET_TOKEN_RE.source, 'g'))) {
    if (match.index > at) blocks.push({ type: 'text', value: value.slice(at, match.index) });
    blocks.push({ type: 'image', id: match[2], alt: match[1] || '图片' });
    at = match.index + match[0].length;
  }
  if (at < value.length || !blocks.length || blocks.at(-1)?.type === 'image') {
    blocks.push({ type: 'text', value: value.slice(at) });
  }
  return blocks;
}

export function joinAssetDocument(blocks) {
  return (blocks || []).map((block) => block.type === 'image'
    ? assetToken(block.id, block.alt)
    : String(block.value || '')).join('');
}

/** 同步到具体笔记后端前，把内部引用改写为该后端能读到的真实路径。 */
export function replaceAssetTokens(source, resolve) {
  return String(source || '').replace(new RegExp(ASSET_TOKEN_RE.source, 'g'), (raw, alt, id) => {
    const href = resolve(id);
    return href ? `![${cleanAlt(alt)}](${href})` : raw;
  });
}

const blobBase64 = async (blob) => {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  for (let at = 0; at < bytes.length; at += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(at, at + 0x8000));
  }
  return btoa(binary);
};

/** 复制 / 单文件下载时临时内嵌图片；持久化事件仍只保存内容哈希引用。 */
export async function inlineAssetTokens(source, load) {
  const refs = new Map();
  for (const id of assetIds(source)) {
    const asset = await load(id);
    if (asset?.blob && asset?.mime) refs.set(id, `data:${asset.mime};base64,${await blobBase64(asset.blob)}`);
  }
  return replaceAssetTokens(source, (id) => refs.get(id));
}
