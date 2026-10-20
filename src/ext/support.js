import { offlineStorageStats } from '../core/offline-store.js';
import { diagnosticReport, DIAGNOSTIC_GUIDANCE } from '../core/diagnostics.js';

export function setupSupport({request, version, storageStats=offlineStorageStats, root=document}) {
  const $=id=>root.getElementById(id);
  let report=null,busy=false;
  const check=$('support-check'),copy=$('support-copy'),status=$('support-status');
  check.onclick=async()=>{
    if(busy)return;busy=true;check.disabled=true;copy.disabled=true;report=null;
    $('support-report').textContent='';status.textContent='正在检查连接与私有存储，不会调用 AI…';
    const results=await Promise.allSettled([request({type:'cf-check'}),storageStats()]);
    const connection=results[0].status==='fulfilled' ? results[0].value : {state:'error'};
    const storage=results[1].status==='fulfilled' ? results[1].value : null;
    // Only the three-part Chromium version is useful for compatibility. Exclude
    // platform, full user agent, extension ID and all account information.
    const browserVersion=globalThis.navigator?.userAgent?.match(/(?:Chrome|Chromium)\/(\d+\.\d+\.\d+)/)?.[1];
    report=JSON.stringify(diagnosticReport({extensionVersion:version,connection,storage,browserVersion}),null,2);
    $('support-report').textContent=report;
    status.textContent=(DIAGNOSTIC_GUIDANCE[connection?.state] || DIAGNOSTIC_GUIDANCE.error)
      + (storage ? ` 待保存到本地服务：${storage.pendingOperations} 条操作（不是写入笔记软件的进度）。` : ' 私有存储检查失败，请先备份能够读取的记录，不要卸载扩展。');
    check.disabled=false;copy.disabled=false;busy=false;
  };
  copy.onclick=async()=>{
    if(!report)return;
    try {await navigator.clipboard.writeText(report);status.textContent='脱敏报告已复制。可在 GitHub 反馈中粘贴，并自行补充复现步骤；请不要附上密钥或私人阅读内容。';}
    catch {status.textContent='浏览器未允许复制，请手动选中下方报告复制。';$('support-report').focus();}
  };
}
