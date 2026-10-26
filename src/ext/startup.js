import { FLOAT, T, shadowHost, releaseThemeHost } from '../skill/theme.js';

// Preference access is also what tells us whether this origin was disabled.
// If it fails on first load, fail closed. Only an explicit toolbar click may
// reveal recovery UI until the user's suppression rules are known again.
export function createContentStartup({ initialize, start, supported, blocked, showBlocked, showError, clearError }) {
  let pending=null,known=false,failed=false,requested=false,started=false;
  const attempt=(explicit=false)=>{
    if(!supported())return Promise.resolve(null);
    requested ||= explicit;
    if(pending)return pending;
    if(started)return Promise.resolve(null);
    pending=Promise.resolve().then(initialize).then(()=>{
      known=true;failed=false;
      const scope=blocked();
      clearError();
      if(scope){if(requested)showBlocked(scope);return null;}
      const app=start();started=!!app;return app;
    }).catch(()=>{
      failed=true;
      if((requested || known) && !blocked())showError();
      return null;
    }).finally(()=>{pending=null;requested=false;});
    return pending;
  };
  return {
    start:()=>attempt(),retry:()=>attempt(true),
    show(){
      if(!supported())return;
      const scope=known && blocked();
      if(scope){showBlocked(scope);return;}
      if(failed)showError();else{requested=true;if(!pending)void attempt(true);}
    },
    get failed(){return failed;},
    get ready(){return known && !failed;},
  };
}

const NOTICE_CSS=`${FLOAT}
 .startup-notice{right:16px;bottom:16px;left:auto;top:auto;padding:15px 16px;max-width:min(390px,calc(100vw - 32px));font-size:12px}
 .startup-notice strong{display:block;font-weight:650;padding-right:26px;color:${T.ink}}
 .startup-notice p{margin:8px 0 12px;line-height:1.7;color:${T.quote}}
 .startup-actions{display:flex;flex-wrap:wrap;gap:8px}.startup-actions button{border:1px solid ${T.line};background:${T.paperRaised};padding:6px 9px}
 .startup-actions .retry{background:${T.accent};border-color:${T.accent};color:${T.onAccent}}
 .startup-notice .dismiss{position:absolute;right:9px;top:9px;padding:3px 7px}
 .startup-hint{font-size:11px;margin-bottom:0!important;overflow-wrap:anywhere}
`;

export function startupFailureNotice({ retry, help }) {
  let host;
  const clear=()=>{if(host){releaseThemeHost(host);host.remove();host=null;}};
  const show=()=>{
    clear();const sh=shadowHost('startup-error',NOTICE_CSS);host=sh.host;
    sh.innerHTML+=`<section class="card startup-notice" role="alert" aria-labelledby="startup-title">
      <strong id="startup-title">ContextFlow 暂时无法准备阅读记录</strong>
      <p>扩展存储连接尚未恢复，本页批注暂不可用。没有清空已有数据，也没有确认任何新内容已保存；请先保留正在编辑的文字。</p>
      <div class="startup-actions"><button class="retry" type="button">重试初始化</button><button class="help" type="button">打开帮助与诊断</button></div>
      <p class="startup-hint" role="status" aria-live="polite"></p><button class="dismiss" type="button" aria-label="关闭提示">×</button>
    </section>`;
    const retryButton=sh.querySelector('.retry'),hint=sh.querySelector('.startup-hint');
    retryButton.onclick=async()=>{
      retryButton.disabled=true;hint.textContent='正在重新连接扩展存储，不会刷新页面或清除数据…';
      try{await retry();}finally{retryButton.disabled=false;}
    };
    sh.querySelector('.help').onclick=async()=>{
      try{await help();hint.textContent='已请求打开扩展帮助页，可在那里运行只读诊断。';}
      catch{hint.textContent='未能打开帮助。请从 Chrome 拼图菜单打开 ContextFlow「扩展程序选项」→「帮助与诊断」。不要卸载或清除数据。';}
    };
    sh.querySelector('.dismiss').onclick=clear;
  };
  return {show,clear};
}
