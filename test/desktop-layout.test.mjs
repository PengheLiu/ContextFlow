import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { JSDOM } from 'jsdom';
import { build } from 'esbuild';
import { installInputModality } from '../desktop/ui/focus.js';

const repository = fileURLToPath(new URL('..', import.meta.url));
test('Only explicit Tab navigation marks keyboard modality, including composed events from a shadow form', () => {
  const dom = new JSDOM('<!doctype html><html><body><div id="host"></div></body></html>', { pretendToBeVisual: true });
  const root = dom.window.document, host = root.getElementById('host').attachShadow({ mode: 'open' });
  host.innerHTML = '<input aria-label="fixture">'; const input = host.querySelector('input');
  const dispose = installInputModality({ root });
  try {
    assert.equal(root.documentElement.hasAttribute('data-input-modality'), false);
    input.focus(); assert.equal(root.documentElement.hasAttribute('data-input-modality'), false, '程序聚焦不能切换键盘模态');
    input.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'a', bubbles: true, composed: true }));
    assert.equal(root.documentElement.hasAttribute('data-input-modality'), false, '文字输入不暴露跳转链接');
    input.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Tab', bubbles: true, composed: true }));
    assert.equal(root.documentElement.dataset.inputModality, 'keyboard');
    input.dispatchEvent(new dom.window.Event('pointerdown', { bubbles: true, composed: true }));
    assert.equal(root.documentElement.dataset.inputModality, 'pointer');
    dom.window.dispatchEvent(new dom.window.Event('blur'));
    assert.equal(root.documentElement.hasAttribute('data-input-modality'), false);
  } finally { dispose(); dom.window.close(); }
});
test('Global feedback owns a layout row rather than covering main or shared settings', () => {
  const dom = new JSDOM(readFileSync(join(repository, 'desktop/ui/index.html'), 'utf8'));
  try {
    const root = dom.window.document;
    assert.equal(root.getElementById('toast').parentElement, root.body);
    assert.equal(root.getElementById('main').getAttribute('tabindex'), '-1');
    assert.equal(root.getElementById('toast-message').getAttribute('tabindex'), '0', '长提示可使用键盘滚动');
    const css = readFileSync(join(repository, 'desktop/ui/styles.css'), 'utf8');
    assert.match(css, /html\[data-input-modality=keyboard\] \.skip-link:focus-visible/);
    assert.match(css, /grid-template-rows:auto minmax\(0,1fr\)/);
  } finally { dom.window.close(); }
});

// Explicit visual gate, not part of headless unit-only environments:
// CONTEXTFLOW_DESKTOP_LAYOUT=1 node --test test/desktop-layout.test.mjs
test('Isolated Electron verifies the shared theme, keyboard, pages, notices and footer actions at 1280 / 820 / 200% zoom', {
  skip: process.env.CONTEXTFLOW_DESKTOP_LAYOUT !== '1', timeout: 90000,
}, async () => {
  const fixture = mkdtempSync(join(tmpdir(), 'contextflow-desktop-layout-'));
  const evidence = join(repository, 'release/product-evidence/desktop-layout'); mkdirSync(evidence, { recursive: true });
  const version = JSON.parse(readFileSync(join(repository, 'package.json'), 'utf8')).version;
  for (const name of ['index.html', 'styles.css', 'icon.png']) copyFileSync(join(repository, 'desktop/ui', name), join(fixture, name));
  const entry = `
    import {startDesktopUI} from ${JSON.stringify(join(repository, 'desktop/ui/renderer.js'))};
    import {destinationIdentity} from ${JSON.stringify(join(repository, 'src/core/destination.js'))};
    const longPath='/Users/Example/个人知识库/项目资料与长期阅读笔记/带有空格的目录/Archive-Research-Notes-2026/Reading/Reference/LongFolderName';
    const config={translate:{provider:'openai',model:'fixture-model',baseUrl:'',apiKeySet:false,target:'简体中文',chunkChars:5000},explain:{backend:'llm'},agent:{id:'',executable:'',codexHome:'',codexDefaultHome:'/Users/Example/.codex',notesDir:'',profile:'safe',profileSource:'new-default'},sync:{backend:'markdown'},markdown:{dir:longPath,folder:'/阅读记录'},obsidian:{vaultPath:'',folder:'/阅读记录'},siyuan:{origin:'http://127.0.0.1:6806',notebookId:'',tokenSet:false},connectionChecks:{}};
    const state={version:${JSON.stringify(version)},platform:'darwin',architecture:'arm64',service:{state:'running',message:'本地连接已准备好'},pairings:[],preferences:{openAtLogin:false},bridgeReady:true,packaged:true,updates:{state:'idle',message:'测试样例'},recoveryPoints:[],journey:{step:'notes',dismissed:true,notesConfirmed:false,notesVerified:false,destination:destinationIdentity(config)},discovery:{agents:{state:'done',items:[{id:'codex',label:'Codex CLI · 测试样例',available:true,path:'/isolated/example-agent',version:'fixture',safeSupport:'verified'}]},notes:{state:'done',items:[{backend:'obsidian',name:'项目资料与长期阅读笔记 · 测试样例',path:longPath,open:false}]}}};
    let errorMessage='测试提示';
    const api={getConfig:async()=>structuredClone(config),putConfig:async patch=>{for(const[key,value]of Object.entries(patch))config[key]={...config[key],...value};return structuredClone(config)},listFolders:async()=>({root:longPath,folders:['/阅读记录']}),listVaults:async()=>({vaults:state.discovery.notes.items}),health:async()=>({serviceVersion:state.version,capabilities:['llm.draft','agent.test','agent.test.draft','agent.codex-home.draft','connection.checks']}),detectAgents:async()=>({agents:state.discovery.agents.items,connectionChecks:config.connectionChecks})};
    const desktop={status:async()=>structuredClone(state),request:async()=>{throw new Error('Fixture refuses network')},onboarding:async patch=>{Object.assign(state.journey,patch);return structuredClone(state.journey)},action:async name=>{if(name==='download')throw new Error(errorMessage);return true},discover:async()=>state.discovery,chooseFolder:async()=>longPath,chooseAgent:async()=>'/isolated/example-agent',preferences:async patch=>Object.assign(state.preferences,patch),revoke:async()=>{},updates:async()=>{throw new Error(errorMessage)},recovery:async()=>true};
    const ui=startDesktopUI({desktop,serviceAPI:api,root:document,poll:false});
    window.layoutFixture={ui,state,config,ready:ui.ready,setError:value=>{errorMessage=value}};
  `;
  // esbuild resolves absolute repository modules, but the rendered UI, profile,
  // fake API and screenshots all remain isolated. No service is started.
  await build({ stdin: { contents: entry, resolveDir: repository, sourcefile: 'layout-fixture.js' },
    bundle: true, format: 'iife', platform: 'browser', target: 'chrome130', charset: 'ascii', outfile: join(fixture, 'app.js'),
    define: { __CONTEXTFLOW_TOKEN__: '""' }, logLevel: 'silent' });
  const runner = join(fixture, 'run-layout.cjs');
  writeFileSync(runner, `
    const {app,BrowserWindow,nativeTheme}=require('electron');
    const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
    const fixture=${JSON.stringify(fixture)}, evidence=${JSON.stringify(evidence)};
    app.setName('ContextFlow Layout Test');app.setPath('userData',path.join(fixture,'profile'));app.disableHardwareAcceleration();nativeTheme.themeSource='light';
    let win;
    app.whenReady().then(async()=>{
      app.dock?.hide();
      win=new BrowserWindow({width:1280,height:900,show:false,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false,backgroundThrottling:false}});
      const issues=[];win.webContents.on('console-message',details=>{if(/Uncaught|ReferenceError|TypeError/.test(details.message||''))issues.push(details.message)});
      const evaluate=code=>win.webContents.executeJavaScript(code);
      await win.loadFile(path.join(fixture,'index.html'));await evaluate('window.layoutFixture.ready');win.show();win.focus();
      const frames=()=>evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
      async function capture(name){
        await frames();
        await evaluate('Promise.race([Promise.all([...document.getAnimations(),...(document.getElementById("configuration")?.shadowRoot?.getAnimations?.()||[])].filter(animation=>Number.isFinite(animation.effect?.getComputedTiming().endTime)).map(animation=>animation.finished.catch(()=>{}))),new Promise(resolve=>setTimeout(resolve,350))])');
        await frames();fs.writeFileSync(path.join(evidence,name),(await win.webContents.capturePage()).toPNG());
      }
      function rect(name){return evaluate('(()=>{const b=document.getElementById('+JSON.stringify(name)+').getBoundingClientRect();return {left:b.left,top:b.top,right:b.right,bottom:b.bottom,width:b.width,height:b.height}})()')}
      await frames();win.webContents.sendInputEvent({type:'keyDown',keyCode:'Tab'});win.webContents.sendInputEvent({type:'keyUp',keyCode:'Tab'});await frames();
      assert.equal(await evaluate('document.activeElement.matches(".skip-link")'),true,'新窗口首次Tab应能到达跳转链接: '+await evaluate('document.activeElement.outerHTML'));
      win.webContents.sendInputEvent({type:'keyDown',keyCode:'Enter'});win.webContents.sendInputEvent({type:'keyUp',keyCode:'Enter'});await frames();
      assert.equal(await evaluate('document.activeElement.id'),'main','跳转链接应真实转移焦点到主要内容');
      win.webContents.sendInputEvent({type:'mouseDown',x:30,y:100,button:'left',clickCount:1});win.webContents.sendInputEvent({type:'mouseUp',x:30,y:100,button:'left',clickCount:1});await frames();
      await evaluate('document.querySelector(".skip-link").focus()');await frames();
      assert.equal(await evaluate('getComputedStyle(document.querySelector(".skip-link")).opacity'),'0','程序焦点不得暴露跳转链接');
      await capture('programmatic-skip-hidden.png');
      // Reset the sequential-focus starting point after the programmatic focus
      // probe; blur alone preserves the previous anchor in Chromium.
      await evaluate('document.body.tabIndex=-1;document.body.focus();document.body.removeAttribute("tabindex")');win.webContents.focus();
      win.webContents.sendInputEvent({type:'keyDown',keyCode:'Tab'});win.webContents.sendInputEvent({type:'keyUp',keyCode:'Tab'});await frames();
      assert.equal(await evaluate('document.activeElement.matches(".skip-link")'),true,'从文档起点Tab应到跳转链接: '+await evaluate('document.activeElement.outerHTML'));
      assert.equal(await evaluate('document.documentElement.dataset.inputModality'),'keyboard');
      assert.equal(await evaluate('getComputedStyle(document.querySelector(".skip-link")).opacity'),'1');await capture('keyboard-skip-visible.png');
      win.webContents.sendInputEvent({type:'mouseDown',x:30,y:100,button:'left',clickCount:1});win.webContents.sendInputEvent({type:'mouseUp',x:30,y:100,button:'left',clickCount:1});await frames();
      assert.equal(await evaluate('document.documentElement.dataset.inputModality'),'pointer');
      assert.equal(await evaluate('getComputedStyle(document.querySelector(".skip-link")).opacity'),'0');
      const cases=[{name:'wide',width:1280,height:900,zoom:1},{name:'minimum',width:820,height:620,zoom:1},{name:'zoom-200',width:820,height:740,zoom:2}],reports=[];
      for(const sample of cases){
        win.setContentSize(sample.width,sample.height);win.webContents.setZoomFactor(sample.zoom);await frames();
        await evaluate('window.layoutFixture.ui.page("notes")');await frames();
        await evaluate('window.layoutFixture.setError('+JSON.stringify('连接测试未完成，请核对服务地址、当前账号与模型权限。 '+('VeryLongDiagnosticIdentifierWithoutSpaces-'.repeat(16)))+');document.querySelector("[data-action=download]").click()');
        for(let n=0;n<30&&await evaluate('document.getElementById("toast").hidden');n++)await new Promise(r=>setTimeout(r,10));
        assert.equal(await evaluate('document.getElementById("toast").hidden'),false);
        const notice=await rect('toast'),main=await rect('main');assert.ok(notice.bottom<=main.top+1,sample.name+': 全局提示与main不能相交');
        assert.equal(await evaluate('document.documentElement.scrollWidth<=innerWidth+1&&document.getElementById("main").scrollWidth<=document.getElementById("main").clientWidth+1'),true,sample.name+': 无页面横向溢出');
        await capture(sample.name+'-notes-toast.png');
        await evaluate('(()=>{const s=window.layoutFixture.ui.settings;const c=s.$("s-chapter-archive");c.open=true;c.disclosure?.sync();s.$("s-mdDir").scrollIntoView({block:"center"});s.$("s-mdDir").focus()})()');await frames();
        const field=await evaluate('(()=>{const s=window.layoutFixture.ui.settings,b=s.$("s-mdDir").getBoundingClientRect(),m=document.getElementById("main").getBoundingClientRect();return {top:b.top,bottom:b.bottom,mainTop:m.top,mainBottom:m.bottom,focus:s.sh.activeElement?.id}})()');
        assert.equal(field.focus,'s-mdDir');assert.ok(field.top>=field.mainTop-1&&field.bottom<=field.mainBottom+1,sample.name+': 共享设置输入框不得被通知遮住');
        await capture(sample.name+'-focused-field.png');
        await evaluate('window.layoutFixture.ui.page("setup")');await evaluate('document.getElementById("main").scrollTop=document.getElementById("main").scrollHeight');await frames();
        const footer=await evaluate('(()=>{const f=document.querySelector(".setup-footer"),m=document.getElementById("main").getBoundingClientRect();return [...f.querySelectorAll("button")].filter(el=>el.getBoundingClientRect().width>0).map(el=>{const b=el.getBoundingClientRect();return {text:el.textContent,left:b.left,right:b.right,top:b.top,bottom:b.bottom,mainLeft:m.left,mainRight:m.right,mainBottom:m.bottom}})})()');
        for(const button of footer)assert.ok(button.left>=button.mainLeft-1&&button.right<=button.mainRight+1&&button.bottom<=button.mainBottom+1,sample.name+': 底部操作必须在窗口内');
        for(let a=0;a<footer.length;a++)for(let b=a+1;b<footer.length;b++)assert.ok(footer[a].right<=footer[b].left||footer[b].right<=footer[a].left||footer[a].bottom<=footer[b].top||footer[b].bottom<=footer[a].top,sample.name+': 底部按钮不能重叠');
        await capture(sample.name+'-setup-footer.png');reports.push({...sample,main,notice,field,footer});
        await evaluate('document.getElementById("dismiss-toast").click()');
      }
      // These are source-fixture checks, not a rebuild of a frozen store ZIP or
      // installation package. Both the renderer and main process stay in this
      // disposable profile; no system appearance preference is changed.
      win.setContentSize(1280,900);win.webContents.setZoomFactor(1);await frames();
      await evaluate('window.layoutFixture.ui.page("ai")');await frames();
      await evaluate('(()=>{const s=window.layoutFixture.ui.settings;s.$("s-model").value="theme-draft-not-saved";s.$("s-model").dispatchEvent(new Event("input",{bubbles:true}))})()');await frames();
      const tokenNames=['paper','paper-raised','ink','ink-soft','accent','accent-hover','on-accent','focus-line','ok','ok-soft','bad','bad-soft','font-sans'];
      const themeProbe=()=>evaluate('('+function(names){
        const host=document.getElementById('configuration'),sh=host.shadowRoot;
        const css=getComputedStyle(document.documentElement),hostCSS=getComputedStyle(host);
        const values=style=>Object.fromEntries(names.map(name=>[name,style.getPropertyValue('--cf-'+name).trim()]));
        const color=(name,parent=document.body)=>{const probe=document.createElement('span');probe.style.color='var(--cf-'+name+')';parent.append(probe);const result=getComputedStyle(probe).color;probe.remove();return result};
        const style=element=>{const value=getComputedStyle(element);return {background:value.backgroundColor,color:value.color,fontFamily:value.fontFamily,border:value.borderTopColor,outline:value.outlineColor,outlineWidth:value.outlineWidth,outlineStyle:value.outlineStyle,shadow:value.boxShadow,transition:value.transitionDuration}};
        return {dark:matchMedia('(prefers-color-scheme:dark)').matches,scheme:css.colorScheme,hostTheme:host.dataset.theme,shellTokens:values(css),shadowTokens:values(hostCSS),colors:Object.fromEntries(['paper','paper-raised','ink','accent','on-accent','focus-line','ok','bad'].map(name=>[name,color(name)])),shadowColors:Object.fromEntries(['paper','paper-raised','ink','accent','on-accent','focus-line'].map(name=>[name,color(name,sh)])),root:style(document.documentElement),body:style(document.body),folio:style(sh.querySelector('.folio')),field:style(sh.getElementById('s-model')),shellCTA:style(document.getElementById('home-primary')),saveCTA:style(sh.getElementById('s-save')),success:style(document.getElementById('browser-badge')),navigation:style(document.querySelector('nav [aria-current=page]'))};
      }.toString()+')('+JSON.stringify(tokenNames)+')');
      const channels=value=>{const match=value.match(/^rgba?\\(([^)]+)\\)$/);assert.ok(match,'Expected computed RGB color: '+value);return match[1].split(/[ ,/]+/).slice(0,3).map(Number)};
      const luminance=value=>channels(value).map(channel=>{const c=channel/255;return c<=.04045?c/12.92:Math.pow((c+.055)/1.055,2.4)}).reduce((sum,value,index)=>sum+value*[.2126,.7152,.0722][index],0);
      const contrast=(a,b)=>{const first=luminance(a),second=luminance(b);return (Math.max(first,second)+.05)/(Math.min(first,second)+.05)};
      await evaluate('(()=>{const f=window.layoutFixture;f.state.pairings=[{id:"fixture-only",instanceId:"isolated-theme-instance",label:"Chrome · 测试样例",updatedAt:0}];f.config.connectionChecks.model={ok:true};return f.ui.refresh()})()');await frames();
      const themes=[];
      for(const appearance of ['light','dark']){
        nativeTheme.themeSource=appearance;
        for(let n=0;n<30&&(await evaluate('matchMedia("(prefers-color-scheme:dark)").matches'))!==(appearance==='dark');n++)await new Promise(resolve=>setTimeout(resolve,10));
        await frames();const probe=await themeProbe();
        assert.equal(probe.dark,appearance==='dark','The Electron process should actually emulate '+appearance);
        assert.equal(probe.scheme,'light','Desktop uses the same deliberate light paper in both OS appearances');
        assert.equal(probe.hostTheme,'light','Desktop settings must not inherit a conflicting OS dark theme');
        for(const name of tokenNames){assert.ok(probe.shellTokens[name],'Missing shell design token '+name);assert.equal(probe.shadowTokens[name],probe.shellTokens[name],appearance+': shell and shared settings '+name)}
        assert.deepEqual(probe.shadowColors, Object.fromEntries(Object.keys(probe.shadowColors).map(name=>[name,probe.colors[name]])),appearance+': rendered shell / Shadow token colors');
        assert.equal(probe.root.background,probe.colors.paper,appearance+': warm canvas');
        assert.equal(probe.folio.color,probe.colors.ink,appearance+': readable form text');
        assert.equal(probe.folio.fontFamily,probe.body.fontFamily,appearance+': same UI font in settings and shell');
        assert.equal(probe.field.fontFamily,probe.body.fontFamily,appearance+': same field font');
        for(const [name,button] of [['desktop CTA',probe.shellCTA],['shared save CTA',probe.saveCTA]]){assert.equal(button.background,probe.colors.accent,appearance+': '+name+' uses brand');assert.equal(button.color,probe.colors['on-accent'],appearance+': '+name+' uses on-accent');assert.ok(contrast(button.background,button.color)>=4.5,appearance+': '+name+' text contrast')}
        assert.equal(probe.success.color,probe.colors.ok,appearance+': success stays semantic green');assert.notEqual(probe.success.color,probe.colors.accent,'Success must not become the brand color');
        const brand=channels(probe.colors.accent),ok=channels(probe.colors.ok);assert.ok(brand[0]>brand[1]&&brand[1]>brand[2],'Brand is warm ochre, not green');assert.ok(ok[1]>ok[0]&&ok[1]>ok[2],'Success retains a distinct green');
        assert.ok(contrast(probe.colors.ink,probe.colors.paper)>=4.5,appearance+': body text contrast');
        await capture('theme-'+appearance+'-ai.png');themes.push({appearance,...probe});
      }
      assert.deepEqual(themes[0].shellTokens,themes[1].shellTokens,'OS dark must not split the fixed desktop theme');
      nativeTheme.themeSource='light';await frames();
      // Verify focus visually, not just the presence of :focus-visible source.
      win.webContents.sendInputEvent({type:'keyDown',keyCode:'Tab'});win.webContents.sendInputEvent({type:'keyUp',keyCode:'Tab'});
      await evaluate('document.querySelector("nav [data-page=ai]").focus()');await frames();
      let focus=await themeProbe();assert.notEqual(focus.navigation.outlineStyle,'none');assert.ok(parseFloat(focus.navigation.outlineWidth)>=2);assert.equal(focus.navigation.outline,focus.colors['focus-line']);
      await evaluate('window.layoutFixture.ui.settings.$("s-model").focus()');await new Promise(resolve=>setTimeout(resolve,200));await frames();focus=await themeProbe();assert.equal(focus.field.border,focus.colors['focus-line']);assert.notEqual(focus.field.shadow,'none');await capture('theme-keyboard-field-focus.png');
      win.webContents.debugger.attach('1.3');
      await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});await frames();
      const motion=await evaluate('(()=>{const sh=document.getElementById("configuration").shadowRoot;return {reduce:matchMedia("(prefers-reduced-motion:reduce)").matches,shell:getComputedStyle(document.querySelector("nav button")).transitionDuration,form:getComputedStyle(sh.getElementById("s-model")).transitionDuration,affordance:getComputedStyle(sh.querySelector(".chapter-affordance .ico")).transitionDuration,disclosure:getComputedStyle(sh.querySelector(".disclosure>summary"),"::before").transitionDuration}})()');
      assert.equal(motion.reduce,true);for(const [name,duration]of Object.entries(motion)){if(name==='reduce')continue;assert.ok(duration.split(',').every(value=>parseFloat(value)<=.001),'Reduced motion must remove '+name+' transitions: '+duration)}
      // Keep reduced motion enabled for the whole capture matrix. A screenshot
      // must show a settled destination, not the previous nav color fading out.
      // Re-use the real UI and fake state for the entire product surface. The
      // Agent draft is never tested or saved; the API refuses network access.
      const pages=[];
      const overflow=label=>evaluate('document.documentElement.scrollWidth<=innerWidth+1&&document.getElementById("main").scrollWidth<=document.getElementById("main").clientWidth+1').then(ok=>assert.equal(ok,true,label+': page must not overflow'));
      const navigation=async name=>{
        await frames();
        const snapshot=await evaluate('(()=>{const color=name=>{const probe=document.createElement("span");probe.style.color="var(--cf-"+name+")";document.body.append(probe);const result=getComputedStyle(probe).color;probe.remove();return result};return {views:[...document.querySelectorAll("main>section[data-view]")].filter(section=>!section.hidden).map(section=>section.dataset.view),accent:color("accent"),quote:color("quote"),buttons:[...document.querySelectorAll("nav [data-page]")].map(button=>({page:button.dataset.page,current:button.getAttribute("aria-current"),color:getComputedStyle(button).color}))}})()');
        const active=name==='setup'?'home':name;
        assert.deepEqual(snapshot.views,[name],name+': exactly one matching content page');
        assert.deepEqual(snapshot.buttons.filter(button=>button.current==='page').map(button=>button.page),[active],name+': exactly one current navigation item');
        for(const button of snapshot.buttons)assert.equal(button.color,button.page===active?snapshot.accent:snapshot.quote,name+': settled navigation color for '+button.page);
        return snapshot;
      };
      for(const sample of cases){
        win.setContentSize(sample.width,sample.height);win.webContents.setZoomFactor(sample.zoom);await frames();
        for(const name of ['home','ai','notes','support']){
          await evaluate('window.layoutFixture.ui.page('+JSON.stringify(name)+')');await frames();
          if(name==='ai')await evaluate('(()=>{const s=window.layoutFixture.ui.settings;for(const id of ["s-chapter-translate","s-chapter-explain"]){s.$(id).open=true;s.$(id).disclosure?.sync()}s.toggleAnswerHelp(true)})()');
          if(name==='support')await evaluate('document.getElementById("service-controls").open=true');
          const nav=await navigation(name);await overflow(sample.name+' '+name);await capture(sample.name+'-page-'+name+'.png');pages.push({size:sample.name,page:name,navigation:nav});
        }
        await evaluate('window.layoutFixture.state.journey.step="finish";window.layoutFixture.ui.refresh()');await evaluate('window.layoutFixture.ui.page("setup")');await frames();const nav=await navigation('setup');await overflow(sample.name+' setup');await capture(sample.name+'-page-setup-finish.png');pages.push({size:sample.name,page:'setup-finish',navigation:nav});
      }
      win.setContentSize(1280,900);win.webContents.setZoomFactor(1);
      await evaluate('window.layoutFixture.ui.page("ai")');
      await evaluate('(()=>{const s=window.layoutFixture.ui.settings;s.$("s-chapter-translate").open=false;s.$("s-chapter-translate").disclosure?.sync();s.$("s-chapter-explain").open=true;s.$("s-chapter-explain").disclosure?.sync();s.$("s-exBackend").value="agent";s.$("s-exBackend").dispatchEvent(new Event("change",{bubbles:true}));s.agents=window.layoutFixture.state.discovery.agents.items;s.wantAgent="codex";s.syncAgentSel();s.$("s-agent").value="codex";s.$("s-agent").dispatchEvent(new Event("change",{bubbles:true}));s.$("s-answerHelpContent").hidden=true;s.$("s-answerHelp").setAttribute("aria-expanded","false");document.getElementById("main").scrollTop=0})()');await frames();await overflow('Agent settings');await capture('wide-page-ai-agent-draft.png');
      assert.equal(await evaluate('window.layoutFixture.ui.settings.$("s-codexHomeField").hidden'),false,'Codex configuration directory is visible in the actual shared form');
      assert.equal(await evaluate('window.layoutFixture.ui.settings.$("s-codexHome").placeholder'),'/Users/Example/.codex','The actual default directory must be visible');
      assert.equal(await evaluate('window.layoutFixture.ui.settings.$("s-codexHome").disabled'),false,'A supported service permits editing the unsaved Codex directory');
      for(const step of ['connect','tools','notes']){await evaluate('window.layoutFixture.state.journey.step='+JSON.stringify(step)+';window.layoutFixture.ui.refresh()');await evaluate('window.layoutFixture.ui.page("setup")');await frames();const nav=await navigation('setup');await overflow('setup '+step);await capture('wide-page-setup-'+step+'.png');pages.push({size:'wide',page:'setup-'+step,navigation:nav})}
      win.webContents.debugger.detach();
      assert.deepEqual(issues,[]);fs.writeFileSync(path.join(evidence,'layout-report.json'),JSON.stringify({format:'ContextFlowDesktopLayout',isolated:true,serviceStarted:false,cases:reports,themes,motion,pages},null,2));
      win.destroy();app.quit();
    }).catch(error=>{console.error(error);if(win&&!win.isDestroyed())win.destroy();app.exit(1)});
  `);
  const electron = (await import('../desktop/node_modules/electron/index.js')).default;
  const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    !/(?:TOKEN|API.?KEY|PASSWORD|SECRET|CREDENTIAL|COOKIE|SESSION|AUTH)/i.test(key) &&
    !/^(?:CONTEXTFLOW_|CODEX_|DSH_|CLAUDE_|ANTHROPIC_|OPENAI_|GEMINI_)/.test(key) &&
    !['NODE_OPTIONS', 'NODE_PATH', 'NODE_EXTRA_CA_CERTS', 'ELECTRON_RUN_AS_NODE', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY'].includes(key)));
  const child = spawn(electron, [runner], { cwd: fixture, env: environment, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = ''; child.stdout.on('data', value => { output += value; }); child.stderr.on('data', value => { output += value; });
  const timer = setTimeout(() => child.kill('SIGTERM'), 80000);
  try { const [code, signal] = await once(child, 'exit'); assert.equal(code, 0, output); assert.equal(signal, null); }
  finally { clearTimeout(timer); if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM'); }
  const report = JSON.parse(readFileSync(join(evidence, 'layout-report.json'), 'utf8'));
  assert.equal(report.cases.length, 3); assert.equal(report.serviceStarted, false);
  assert.deepEqual(report.themes.map(value => value.appearance), ['light', 'dark']);
  assert.equal(report.motion.reduce, true); assert.equal(report.pages.length, 18);
  console.log('Electron layout evidence: '+evidence);
});
