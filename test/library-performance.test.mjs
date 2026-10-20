import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { libraryArticles, searchLibrary } from '../src/core/reading-library.js';
// Repeatable synthetic workload; not a claim about every user's hardware.
const events=Array.from({length:10000},(_,i)=>({id:`bench-${i}`,urlKey:`article-${i%2000}`,
  url:`https://example.org/${i%2000}`,title:`学习材料 ${i%2000}`,text:'原文段落 '.repeat(35),
  action:i%2 ? 'comment' : 'explain',value:`知识管理 独立思考 ${i}`,
  extra:{question:'如何应用',supplement:'持续积累'},updatedAt:i}));
const start=performance.now(),rows=libraryArticles(events),indexed=performance.now()-start;
const times=[];for(let i=0;i<30;i++) {const t=performance.now();searchLibrary(rows,i%2 ? '知识管理 持续积累' : '不存在的关键词','all');times.push(performance.now()-t);}
times.sort((a,b)=>a-b);const p95=times[Math.floor(times.length*.95)];
assert.equal(rows.length,2000);assert.equal(searchLibrary(rows,'知识管理 持续积累').length,2000);
assert.ok(indexed<5000,'万条索引不应阻塞数秒');assert.ok(p95<500,'已建立索引的搜索不应持续阻塞交互');
console.log(`阅读库基准：10,000 条 / 2,000 篇，索引 ${indexed.toFixed(1)} ms，30 次搜索 p95 ${p95.toFixed(1)} ms（合成数据，本机）`);
