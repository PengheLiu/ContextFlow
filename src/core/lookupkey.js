// 查询记录（翻译 / 解释）的去重键。
//
// 思路：用内容派生**稳定 id**，让服务端已有的 upsert 逻辑自然合并 ——
// 与全文笔记用 `note:<urlKey>` 是同一手法，不需要额外的去重代码路径。
//
// 去重口径：
//   translate —— 原文 + 目标语言。同一段反复翻译只留一条
//   explain   —— 原文 + 你提的问题。同一段问**不同**问题是两条不同记录，
//                不该合并；重复问同一个问题才合并（答案会被刷新）
//   summary   —— 整篇一条（没有选区、没有问题），所以键里只有 action
//
// 归一化口径（只作用于**键**，展示的原文保持用户实际选中的样子）：
//   · 折叠空白
//   · 去掉首尾标点 —— 实测里 "Threat model" 与 "Threat model." 产生了两条记录，
//     用户视角这就是同一段，只是一次多带了句点。词边界吸附不管标点，得在这里处理。
//   · 不做大小写归一：翻译场景下合并 "IT"/"it" 尚可接受，但展示时会看到原文
//     被前一次覆盖，反而困惑。
const EDGE_PUNCT = /^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu;

// 字段分隔符。不能用空格 —— 正文本身含空格，`ex|AB|C` 与 `ex|A|BC` 会撞成同一个键。
// 写成转义序列而非字面控制字符：字面 NUL 会让 git 把整个源文件判成二进制。
const SEP = '\u001f';

const norm = (s) => {
  // 先折叠空白（\n \t \r 都在 \s 内），再剥掉残余控制字符 ——
  // 否则正文里若真出现 SEP，字段边界就会被伪造出来。
  const flat = String(s ?? '').replace(/\s+/g, ' ').replace(/[\u0000-\u001f]/g, '').trim();
  const trimmed = flat.replace(EDGE_PUNCT, '');
  // 整段都是标点时不要归一成空串，否则所有这类选区会互相合并
  return trimmed || flat;
};

/** 从事件或待保存的载荷里取出去重口径 */
export function lookupKey(ev) {
  const text = norm(ev.text);
  // 速览是"整篇一条"，没有选区也没有问题 —— 键里只有 action。
  // 不让它落进翻译那条分支：那样 id 会带 tr: 前缀，而这个 id 会出现在笔记的
  // 标记注释里（<!-- cf:tr:xxx -->），把速览标成翻译是误导。
  if (ev.action === 'summary') return `sm${SEP}`;
  if (ev.action === 'explain') return `ex${SEP}${text}${SEP}${norm(ev.extra?.question)}`;
  return `tr${SEP}${text}${SEP}${norm(ev.extra?.target)}`;
}

/**
 * FNV-1a 变体，输出 16 位十六进制（约 64 bit）。
 * 刻意不用 crypto.subtle —— 它要求安全上下文，而 http 的博客页面拿不到，
 * 那会让去重在一部分站点上静默失效。这里的抗碰撞需求很弱，够用。
 */
export function hashKey(str) {
  let h1 = 0x811c9dc5, h2 = 0x01000193;
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    h1 = (h1 ^ c) * 0x01000193 >>> 0;
    h2 = (h2 + c) * 0x85ebca6b >>> 0;
    h2 ^= h2 >>> 13;
  }
  return (h1 >>> 0).toString(16).padStart(8, '0') + (h2 >>> 0).toString(16).padStart(8, '0');
}

/** 稳定 id：同一篇文章内同一次查询恒定 */
export function lookupId(urlKey, ev) {
  const prefix = { summary: 'sm', explain: 'ex' }[ev.action] || 'tr';
  return `${prefix}:${hashKey(`${urlKey}${SEP}${lookupKey(ev)}`)}`;
}
