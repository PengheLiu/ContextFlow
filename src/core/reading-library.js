// Portable reading data only. Never include connection configuration, credentials,
// cached full articles, queue leases or local CLI/session identifiers.
import { assetIds, ALLOWED_IMAGE_TYPES, MAX_ASSET_BYTES } from './assets.js';
import { eventIdentityKey } from './urlkey.js';

export const BACKUP_FORMAT = 'contextflow-reading-backup';
export const MAX_BACKUP_BYTES = 32 * 1024 * 1024;
const ACTIONS = new Set(['highlight','comment','explain','translate','summary','note']);
const text = (value, max = 1_000_000) => {
  if (value == null) return '';
  if (typeof value !== 'string' || value.length > max) throw new Error('记录字段格式无效或过长');
  return value;
};
const clock = value => Number.isFinite(value) && value >= 0 && value <= 8.64e15 ? value : 0;
export const safeReadingUrl = raw => {
  try { const url=new URL(raw);return ['http:','https:'].includes(url.protocol) && !url.username && !url.password ? url.href : ''; }
  catch { return ''; }
};

export function readingEvent(raw) {
  if (!raw || typeof raw !== 'object' || !ACTIONS.has(raw.action) || raw.deletedAt) throw new Error('备份包含无效或已删除的记录');
  const id=text(raw.id,512),urlKey=text(raw.urlKey,16384);
  if (!id || !urlKey) throw new Error('备份记录缺少标识');
  const event={id,urlKey,url:text(raw.url,16384),title:text(raw.title,4096),action:raw.action,
    text:text(raw.text),value:raw.value == null ? null : text(raw.value),
    color:['yellow','green','blue','pink'].includes(raw.color) ? raw.color : null,
    parentId:raw.parentId ? text(raw.parentId,512) : null,
    createdAt:clock(raw.createdAt),updatedAt:clock(raw.updatedAt || raw.createdAt),mutationId:text(raw.mutationId,512)};
  const a=raw.anchor;
  event.anchor=a && typeof a==='object' ? {exact:text(a.exact),prefix:text(a.prefix),suffix:text(a.suffix),
    ...(Number.isSafeInteger(a.start) && a.start>=0 ? {start:a.start} : {}),
    ...(Number.isSafeInteger(a.end) && a.end>=0 ? {end:a.end} : {})} : null;
  const extra={};
  for(const key of ['question','supplement','target']) if(raw.extra?.[key]!=null) extra[key]=text(raw.extra[key]);
  if(Number.isSafeInteger(raw.extra?.offset) && raw.extra.offset>=0)extra.offset=raw.extra.offset;
  if(Array.isArray(raw.extra?.history))extra.history=raw.extra.history.slice(-5).map(row=>({value:text(row.value),at:clock(row.at)}));
  if(raw.extra?.status) Object.assign(extra,{status:'canceled',error:'从备份恢复的未完成请求，请手动重试',progress:'',jobId:null});
  event.extra=extra;
  return event;
}

export function referencedAssets(events) {
  return [...new Set(events.flatMap(e=>assetIds([e.value,e.extra?.supplement,...(e.extra?.history || []).map(h=>h.value)].filter(Boolean).join('\n'))))];
}

export function libraryArticles(events) {
  const groups=new Map();
  for(const event of events.filter(e=>!e.deletedAt)) {
    const key=eventIdentityKey(event);
    if(!groups.has(key))groups.set(key,{key,title:'未命名文章',url:'',updatedAt:0,events:[],search:''});
    const row=groups.get(key);row.events.push(event);
    const at=clock(event.updatedAt || event.createdAt);
    if(at>=row.updatedAt) { row.updatedAt=at;row.title=event.title || row.title;row.url=safeReadingUrl(event.url) || row.url; }
  }
  for(const row of groups.values()) row.search=[row.title,row.url,...row.events.flatMap(e=>[e.text,e.value,e.extra?.question,e.extra?.supplement])].filter(Boolean).join('\n').toLocaleLowerCase();
  return [...groups.values()].sort((a,b)=>b.updatedAt-a.updatedAt || a.key.localeCompare(b.key));
}

export function searchLibrary(articles, query, kind='all') {
  const words=String(query || '').trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  return articles.filter(row=>words.every(word=>row.search.includes(word)) &&
    (kind==='all' || row.events.some(e=>kind==='comments' ? ['highlight','comment'].includes(e.action) : e.action===kind)));
}

const base64 = bytes => {
  let binary='';for(let i=0;i<bytes.length;i+=32768)binary+=String.fromCharCode(...bytes.subarray(i,i+32768));
  return btoa(binary);
};
const digest = async bytes => [...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(n=>n.toString(16).padStart(2,'0')).join('');

// The byte budget is the format's resource boundary, in both directions. Older
// encoders could produce valid <32 MB files with >50k records or >5k images;
// a hidden import-only count limit made those self-generated files unusable.
// Also bound the normalized records, so a tiny hand-written input cannot expand
// into an arbitrarily large in-memory restore just by omitting default fields.
function backupEvents(rows) {
  if(!Array.isArray(rows))throw new Error('备份记录列表无效');
  const events=[],ids=new Set(),encoder=new TextEncoder();let bytes=2;
  for(const row of rows) {
    const event=readingEvent(row);
    if(ids.has(event.id))throw new Error('备份中存在重复记录标识');
    bytes+=encoder.encode(JSON.stringify(event)).byteLength+(events.length ? 1 : 0);
    if(bytes>MAX_BACKUP_BYTES)throw new Error('完整备份超过 32 MB 安全上限，原记录不受影响');
    ids.add(event.id);events.push(event);
  }
  return {events,bytes};
}

export async function encodeReadingBackup(snapshot, appVersion='') {
  if(!Array.isArray(snapshot?.events) || !Array.isArray(snapshot?.assets))throw new Error('阅读备份快照格式无效');
  const {events,bytes:eventBytes}=backupEvents(snapshot.events.filter(e=>!e.deletedAt));
  const available=new Map(snapshot.assets.map(a=>[a.id,a])),assets=[];
  let size=eventBytes;
  for(const id of referencedAssets(events)) {
    const asset=available.get(id);
    if(!asset?.blob)throw new Error('部分记录的图片尚未保存在此扩展中，请先在原文章加载图片后重试，避免生成不完整备份');
    if(!ALLOWED_IMAGE_TYPES.has(asset.mime) || !asset.blob.size || asset.blob.size>MAX_ASSET_BYTES)throw new Error('备份图片为空、格式无效或超过 8 MB');
    size+=Math.ceil(asset.blob.size/3)*4;
    if(size>MAX_BACKUP_BYTES)throw new Error('完整备份超过 32 MB 安全上限，请先按文章导出 Markdown；原记录不会被删除');
    const bytes=new Uint8Array(await asset.blob.arrayBuffer());
    if(await digest(bytes)!==id)throw new Error('图片校验失败，未生成不完整备份');
    assets.push({id,mime:asset.mime,name:text(asset.name,512),data:base64(bytes)});
  }
  const result=JSON.stringify({format:BACKUP_FORMAT,version:1,appVersion,exportedAt:Date.now(),events,assets});
  if(new Blob([result]).size>MAX_BACKUP_BYTES)throw new Error('完整备份超过 32 MB 安全上限，原记录不受影响');
  return result;
}

export async function decodeReadingBackup(source) {
  if(typeof source!=='string' || new Blob([source]).size>MAX_BACKUP_BYTES)throw new Error('请选择不超过 32 MB 的 ContextFlow JSON 备份');
  let raw;try{raw=JSON.parse(source);}catch{throw new Error('文件不是有效的 JSON 备份');}
  if(raw?.format!==BACKUP_FORMAT || raw.version!==1)throw new Error('不支持此备份格式或版本，请使用兼容版本的 ContextFlow');
  if(!Array.isArray(raw.assets))throw new Error('备份图片列表无效');
  const {events}=backupEvents(raw.events);
  const refs=new Set(referencedAssets(events)),assets=[],seen=new Set();
  for(const a of raw.assets) {
    if(!/^[a-f0-9]{64}$/.test(a?.id) || seen.has(a.id) || !ALLOWED_IMAGE_TYPES.has(a.mime) ||
      typeof a.data!=='string' || a.data.length>Math.ceil(MAX_ASSET_BYTES/3)*4 || a.data.length%4!==0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(a.data)) throw new Error('备份图片数据无效');
    seen.add(a.id);
    const bytes=Uint8Array.from(atob(a.data),c=>c.charCodeAt(0));
    if(!bytes.length || bytes.length>MAX_ASSET_BYTES || await digest(bytes)!==a.id)throw new Error('备份图片完整性校验失败，未写入任何记录');
    if(refs.has(a.id))assets.push({id:a.id,mime:a.mime,name:text(a.name,512),size:bytes.length,blob:new Blob([bytes],{type:a.mime}),createdAt:Date.now(),uploadedAt:0});
  }
  for(const id of refs)if(!seen.has(id))throw new Error('备份缺少引用的图片，未写入任何记录');
  return {events,assets,exportedAt:clock(raw.exportedAt),articleCount:libraryArticles(events).length};
}
