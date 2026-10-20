import { readingLibrarySnapshot, restoreReadingLibrary, getOfflineAsset } from '../core/offline-store.js';
import { libraryArticles, searchLibrary, encodeReadingBackup, decodeReadingBackup, MAX_BACKUP_BYTES } from '../core/reading-library.js';
import { renderArticleMarkdown, safeMarkdownFilename } from '../core/markdown.js';
import { inlineAssetTokens, assetIds, splitAssetDocument } from '../core/assets.js';
import { BASE, T } from '../skill/theme.js';
import { renderMarkdownInto, MARKDOWN_CSS } from '../skill/markdown-view.js';

const CSS=`
 [hidden]{display:none!important}
 :host{display:block;container-type:inline-size}.library{color:${T.ink};font:13px/1.65 ${T.sans};padding-top:30px}
 h1{font:600 30px/1.4 ${T.serif};margin:0 0 9px}h2{font-size:17px;line-height:1.5;margin:0;overflow-wrap:anywhere}
 p{margin:7px 0 15px;overflow-wrap:anywhere}.muted{color:${T.quote}}.kicker{font-size:11px;color:${T.accent};letter-spacing:.1em;font-weight:700;margin:0 0 10px}
 .library-tools,.preview-tools,.data-actions,.pager{display:flex;align-items:center;gap:9px;flex-wrap:wrap}
 button.action{padding:8px 12px;border:1px solid ${T.line};background:${T.paperRaised};font-size:12px;min-height:36px}
 button.primary{background:${T.accent};border-color:${T.accent};color:${T.paperRaised}}
 .stats{margin:19px 0 15px;padding:12px 14px;border:1px solid ${T.line};border-radius:8px;background:${T.paperRaised};color:${T.inkSoft}}
 .library-tools{margin:15px 0;align-items:end}.search{flex:1;min-width:170px}label{display:block;font-size:12px;color:${T.inkSoft}}
 input,select{width:100%;min-width:0;margin-top:5px;padding:9px 10px;border:1px solid ${T.line};border-radius:6px;background:${T.paperRaised};color:${T.ink};font:13px ${T.sans};min-height:38px}
 .results{margin:0 0 10px;color:${T.quote};font-size:12px}.library-grid{display:grid;grid-template-columns:minmax(230px, .8fr) minmax(0,1.5fr);gap:18px;align-items:start}
 .article-list{display:grid;gap:8px}.article-button{display:block;width:100%;min-width:0;text-align:left;padding:13px;border:1px solid ${T.line};border-radius:8px;background:${T.paperRaised}}
 .article-button[aria-pressed=true]{border-color:${T.accent};background:${T.accentWash}}.article-title{display:block;font-weight:650;line-height:1.5;overflow-wrap:anywhere}
 .article-meta,.article-excerpt{display:block;margin-top:5px;font-size:11.5px;color:${T.quote};overflow-wrap:anywhere}.article-excerpt{display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:2;overflow:hidden}
 .preview{position:sticky;top:12px;max-height:calc(100vh - 32px);overflow-y:auto;min-width:0;border:1px solid ${T.line};border-radius:9px;background:${T.paperRaised};padding:18px}.preview-heading{outline-offset:4px}
 .preview-tools{padding:11px 0 14px;margin-bottom:14px;border-bottom:1px solid ${T.lineSoft};font-size:12px}.preview-tools a{color:${T.accent};text-underline-offset:3px}.preview-body{min-width:0}
 .preview-body figure{margin:12px 0}.preview-body img{max-width:100%;max-height:480px;border:1px solid ${T.line};border-radius:6px;object-fit:contain}.preview-body figcaption{font-size:11.5px;color:${T.quote}}
 .empty{padding:28px 17px;border:1px dashed ${T.line};border-radius:8px;text-align:center;color:${T.quote}}.empty strong{display:block;color:${T.inkSoft};font-size:14px}.empty p{margin-bottom:0}
 .pager{justify-content:space-between;margin:13px 0;font-size:12px;color:${T.quote}}.data-box{margin:30px 0 15px;border-top:1px solid ${T.line};padding-top:23px}.data-box h2{font-family:${T.serif};font-size:20px}
 .notice{position:sticky;top:12px;z-index:5;padding:10px 12px;border:1px solid ${T.line};border-radius:6px;background:${T.paperRaised};color:${T.inkSoft};margin:12px 0;font-size:12px;overflow-wrap:anywhere;box-shadow:${T.shadowControl}}.notice:empty{display:none}.notice.bad{background:${T.badSoft};color:${T.bad};border-color:${T.bad}}
 .restore-preview{margin-top:14px;padding:16px;border:1px solid ${T.lineStrong};border-radius:8px;background:${T.paperRaised}}.restore-preview p{font-size:12px}
 .privacy-note{font-size:11.5px;color:${T.quote};line-height:1.65;margin-top:11px}.preview-body .md{font-size:13px}
 .library-shortcuts{margin:0 0 15px}.library-shortcuts button{padding:3px 0;color:${T.accent};font-size:12px}
 @container(max-width:700px){.library-grid{grid-template-columns:minmax(0,1fr)}.preview{position:static;max-height:none;overflow-y:visible;padding:15px}.library-tools{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr)}.library-tools>.search{grid-column:1/-1}.library-tools>button{grid-column:1/-1;justify-self:end}.library h1{font-size:27px}}
`;
const FORMAT_TIME=time=>time ? new Date(time).toLocaleString('zh-CN',{hour12:false}) : '时间未记录';
const node=(tag,className,value)=>{const el=document.createElement(tag);if(className)el.className=className;if(value!=null)el.textContent=value;return el;};

export class ReadingLibrary {
  constructor(host,{flush=async()=>{},version='',snapshot=readingLibrarySnapshot,restore=restoreReadingLibrary,loadAsset=getOfflineAsset}={}) {
    this.o={flush,version,snapshot,restore,loadAsset};this.urls=new Set();this.page=0;this.articles=[];
    this.sh=host.attachShadow({mode:'open'});
    this.sh.innerHTML=`<style>${BASE}${MARKDOWN_CSS}${CSS}</style><section class="library" aria-labelledby="library-title">
      <p class="kicker">YOUR READING, KEPT TOGETHER</p><h1 id="library-title">我的阅读库</h1>
      <p class="muted">找回读过的原文与自己的想法。不需要本地服务，也不会调用 AI。</p>
      <div class="library-shortcuts"><button id="library-jump-data" type="button">备份与恢复 ↓</button></div>
      <div class="stats" id="library-stats">正在读取已保存的记录…</div>
      <p class="notice" id="library-notice" role="status" aria-live="polite" aria-atomic="true"></p>
      <div class="library-tools"><label class="search" for="library-query">搜索全部文章<input id="library-query" type="search" maxlength="256" placeholder="标题、网址、原文、问题或笔记" autocomplete="off"></label>
      <label for="library-kind">内容类型<select id="library-kind"><option value="all">全部内容</option><option value="comments">批注与高亮</option><option value="explain">解释</option><option value="translate">翻译</option><option value="summary">速览</option><option value="note">我的笔记</option></select></label>
      <label for="library-sort">排序<select id="library-sort"><option value="recent">最近更新</option><option value="oldest">最早更新</option><option value="title">标题</option></select></label>
      <button type="button" class="action" id="library-refresh">刷新记录</button></div>
      <p class="results" id="library-results" role="status" aria-live="polite"></p>
      <div class="library-grid"><div><div class="article-list" id="library-list"></div><div class="pager" id="library-pager" hidden><button type="button" id="library-prev">上一页</button><span id="library-page"></span><button type="button" id="library-next">下一页</button></div></div>
      <article class="preview" id="library-preview" aria-labelledby="library-preview-title"><h2 class="preview-heading" id="library-preview-title" tabindex="-1">在左侧选择一篇文章</h2><div class="preview-tools" id="library-preview-tools" hidden></div><div class="preview-body" id="library-preview-body"></div></article></div>
      <section class="data-box" aria-labelledby="library-data-title"><h2 id="library-data-title">备份与恢复</h2><p class="muted">卸载扩展会清除浏览器内记录。保留一份备份，换浏览器或重新安装后也能找回。</p>
      <div class="data-actions"><button class="action primary" type="button" id="library-backup">下载完整备份</button><button class="action" type="button" id="library-choose">选择备份文件</button><input id="library-file" type="file" accept=".json,application/json" hidden></div>
      <p class="privacy-note">备份包含此扩展已保存的有效阅读记录、历史回答与引用图片，不含已删除内容、原网页全文、API key 或配对码，也不包含只存在于本地服务的记录。JSON 文件可读且未加密，请妥善保管；单个备份上限 32 MB。</p>
      <section class="restore-preview" id="library-restore-preview" aria-labelledby="library-restore-title" hidden><h3 id="library-restore-title">确认恢复内容</h3><p id="library-restore-info"></p><p>只补充缺失记录；已有记录（含已删除记录）保持不变。不会恢复运行中的 AI 任务或写入笔记软件。恢复后刷新原文章查看，记录按原有规则保存到已连接的本地服务。</p><div class="data-actions"><button class="action primary" type="button" id="library-restore">确认补充记录</button><button class="action" type="button" id="library-cancel">取消恢复</button></div></section>
      </section></section>`;
    this.$=id=>this.sh.getElementById(id);
    const query=this.$('library-query');
    const search=()=>{
      clearTimeout(this.searchTimer);this.page=0;
      if(this.articles.length<500)this.renderList();
      else this.searchTimer=setTimeout(()=>this.renderList(),120);
    };
    query.oninput=e=>{if(!e.isComposing)search();};
    query.oncompositionend=search;
    for(const id of ['library-kind','library-sort'])this.$(id).onchange=()=>{this.page=0;this.renderList();};
    this.$('library-refresh').onclick=()=>this.action(()=>this.refresh(true));
    this.$('library-jump-data').onclick=()=>{this.$('library-data-title').tabIndex=-1;this.$('library-data-title').focus();this.$('library-data-title').scrollIntoView({block:'start'});};
    this.$('library-prev').onclick=()=>{this.page--;this.renderList();};
    this.$('library-next').onclick=()=>{this.page++;this.renderList();};
    this.$('library-backup').onclick=()=>this.action(()=>this.backup());
    this.$('library-choose').onclick=()=>this.$('library-file').click();
    this.$('library-file').onchange=()=>this.action(()=>this.inspectFile(this.$('library-file').files?.[0]));
    this.$('library-cancel').onclick=()=>this.cancelRestore();
    this.$('library-restore').onclick=()=>this.action(()=>this.restore());
  }
  notice(message,bad=false) {const el=this.$('library-notice');el.textContent=message;el.classList.toggle('bad',bad);el.setAttribute('role',bad?'alert':'status');}
  async action(fn) {
    if(this.busy)return;this.busy=true;
    const controls=[...this.sh.querySelectorAll('.action')];for(const el of controls){el.disabled=true;el.setAttribute('aria-busy','true');}
    try {await fn();}catch(error){this.notice(error.message || '操作失败，原记录保留，请重试',true);}
    finally{this.busy=false;for(const el of controls){el.disabled=false;el.removeAttribute('aria-busy');}if(this.focusRestore){this.focusRestore=false;this.$('library-restore').focus();}}
  }
  async refresh(flush=false) {
    if(flush)await this.o.flush();
    const snapshot=await this.o.snapshot();this.articles=libraryArticles(snapshot.events);this.snapshot=snapshot;
    this.$('library-stats').textContent=`${this.articles.length} 篇文章 · ${snapshot.events.filter(e=>!e.deletedAt).length} 条已保存记录`;
    this.renderList();
  }
  renderList() {
    clearTimeout(this.searchTimer);
    const results=searchLibrary(this.articles,this.$('library-query').value,this.$('library-kind').value);
    if(this.$('library-sort').value==='oldest')results.reverse();
    if(this.$('library-sort').value==='title')results.sort((a,b)=>a.title.localeCompare(b.title,'zh-CN'));
    this.page=Math.min(Math.max(0,this.page),Math.max(0,Math.ceil(results.length/20)-1));
    this.$('library-results').textContent=`找到 ${results.length} / ${this.articles.length} 篇文章`;
    const list=this.$('library-list');list.replaceChildren();
    const visible=results.slice(this.page*20,this.page*20+20);
    if(!visible.some(a=>a.key===this.selected))this.selected=visible[0]?.key;
    for(const row of visible) {
      const button=node('button','article-button');button.type='button';button.setAttribute('aria-pressed',String(row.key===this.selected));
      button.setAttribute('aria-controls','library-preview');button.append(node('span','article-title',row.title));
      const domain=row.url ? new URL(row.url).hostname : '原文链接不可用';
      button.append(node('span','article-meta',`${domain} · ${row.events.length} 条记录`),node('span','article-meta',FORMAT_TIME(row.updatedAt)));
      const note=row.events.find(e=>e.action==='comment' || e.action==='note') || row.events.find(e=>e.value) || row.events[0];
      const excerpt=splitAssetDocument(note?.value || note?.text || '已保存阅读记录').map(block=>block.type==='image' ? `〔图片：${block.alt || '截图'}〕` : block.value).join('');
      button.append(node('span','article-excerpt',excerpt));
      button.onclick=()=>{this.selected=row.key;this.renderList();this.$('library-preview-title').focus({preventScroll:true});if(this.sh.host.getBoundingClientRect().width<=700)this.$('library-preview').scrollIntoView({block:'start'});};
      list.append(button);
    }
    if(!results.length) {
      const empty=node('div','empty');empty.append(node('strong','',this.articles.length ? '没有匹配的文章' : '你的第一条批注会出现在这里'),node('p','',this.articles.length ? '试试更短的关键词，或切回「全部内容」。' : '回到文章选中文字并批注，保存后点击「刷新记录」。'));list.append(empty);
    }
    this.$('library-pager').hidden=results.length<=20;
    this.$('library-prev').disabled=this.page===0;this.$('library-next').disabled=(this.page+1)*20>=results.length;
    this.$('library-page').textContent=`第 ${this.page+1} / ${Math.max(1,Math.ceil(results.length/20))} 页`;
    const selected=results.find(a=>a.key===this.selected);
    if(this.previewRow!==selected){this.previewRow=selected;this.renderPreview(selected);}
  }
  renderPreview(row) {
    this.releaseImages();const body=this.$('library-preview-body'),tools=this.$('library-preview-tools');body.replaceChildren();tools.replaceChildren();tools.hidden=!row;
    this.$('library-preview-title').textContent=row?.title || '选择文章后，在这里回顾记录';if(!row)return;
    if(row.url){const link=node('a','','打开原文 ↗');link.href=row.url;link.target='_blank';link.rel='noopener noreferrer';tools.append(link);}
    const download=node('button','action','下载 Markdown');download.type='button';download.onclick=()=>this.action(()=>this.downloadArticle(row));tools.append(download);
    const back=node('button','','返回列表');back.type='button';back.onclick=()=>{const selected=this.$('library-list').querySelector('[aria-pressed=true]') || this.$('library-query');selected.focus();selected.scrollIntoView({block:'center'});};tools.append(back);
    const source=renderArticleMarkdown({title:row.title,url:row.url,events:row.events});
    for(const block of splitAssetDocument(source.replace(/^#[^\n]*\n/,'').slice(0,200000))) {
      if(block.type==='text'){const part=node('div');renderMarkdownInto(part,block.value);body.append(part);continue;}
      const figure=node('figure'),caption=node('figcaption','',block.alt || '图片附件');figure.append(caption);body.append(figure);
      Promise.resolve().then(()=>this.o.loadAsset(block.id)).then(asset=>{
        if(this.previewRow!==row || !figure.isConnected)return;
        if(!asset?.blob){caption.textContent='图片尚未缓存在此扩展中，请在原文章加载后重试';return;}
        const href=URL.createObjectURL(asset.blob);this.urls.add(href);const img=node('img');img.alt=block.alt || '图片附件';img.src=href;figure.prepend(img);
      }).catch(()=>{if(figure.isConnected)caption.textContent='图片暂不可用，原记录仍保留';});
    }
    if(source.length>200000)body.append(node('p','muted','预览仅显示前 20 万字符；下载包含完整记录。'));
  }
  releaseImages(){for(const url of this.urls)URL.revokeObjectURL(url);this.urls.clear();}
  async downloadArticle(row) {
    await this.o.flush();await this.refresh();
    row=this.articles.find(a=>a.key===row.key);if(!row)throw new Error('这篇文章已没有有效记录，请刷新列表');
    const source=await inlineAssetTokens(renderArticleMarkdown({title:row.title,url:row.url,events:row.events}),this.o.loadAsset);
    if(assetIds(source).length)throw new Error('部分图片暂不可用，请先在原文章加载后重试，未下载不完整文件');
    this.download(source,safeMarkdownFilename(row.title,row.key),'text/markdown');this.notice('已生成 Markdown，请确认浏览器下载完成。');
  }
  download(source,name,type='application/json') {
    const href=URL.createObjectURL(new Blob([source],{type:`${type};charset=utf-8`})),link=node('a');link.href=href;link.download=name;
    this.sh.append(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(href),1000);
  }
  async backup() {
    this.notice('正在等待网页编辑保存并校验备份图片…');await this.o.flush();
    const source=await encodeReadingBackup(await this.o.snapshot({withAssets:true}),this.o.version);
    this.download(source,`contextflow-reading-${new Date().toISOString().slice(0,10)}.json`);
    this.notice('已生成包含图片的完整阅读备份，请确认浏览器下载完成并妥善保管。配置与密钥未导出。');
  }
  async inspectFile(file) {
    this.pendingRestore=null;this.$('library-restore-preview').hidden=true;this.$('library-file').value='';if(!file)return;
    if(file.size>MAX_BACKUP_BYTES)throw new Error('备份不能超过 32 MB，原记录未改动');
    this.notice('正在校验备份，暂未写入任何记录…');
    this.pendingRestore=await decodeReadingBackup(await file.text());
    const backup=this.pendingRestore;
    const current=await this.o.snapshot(),ids=new Set(current.events.map(e=>e.id)),deleted=new Set(current.events.filter(e=>e.deletedAt).map(e=>e.id));
    const additions=backup.events.filter(e=>!ids.has(e.id) && !(e.parentId && deleted.has(e.parentId))).length;
    this.$('library-restore-info').textContent=`${file.name} · ${backup.articleCount} 篇文章 · ${backup.events.length} 条记录 · ${backup.assets.length} 张图片。预计补充 ${additions} 条、保留已有 ${backup.events.length-additions} 条，确认时会再次检查。备份时间：${FORMAT_TIME(backup.exportedAt)}。`;
    this.$('library-restore-preview').hidden=false;this.focusRestore=true;this.notice('备份校验通过。请核对内容，确认后才会补充记录。');
  }
  cancelRestore(){this.pendingRestore=null;this.$('library-restore-preview').hidden=true;this.$('library-file').value='';this.notice('已取消恢复，没有改动阅读记录。');this.$('library-choose').focus();}
  async restore() {
    if(!this.pendingRestore)return;await this.o.flush();
    const result=await this.o.restore(this.pendingRestore);this.pendingRestore=null;this.$('library-restore-preview').hidden=true;
    await this.refresh();this.notice(`恢复完成：补充 ${result.added} 条，保留已有 ${result.skipped} 条。刷新原文章后可查看；未运行 AI 或写入笔记软件。`);this.$('library-choose').focus();
  }
}
