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
test('Isolated Electron renders keyboard, notices, long paths and footer actions at 1280 / 820 / 200% zoom', {
  skip: process.env.CONTEXTFLOW_DESKTOP_LAYOUT !== '1', timeout: 60000,
}, async () => {
  const fixture = mkdtempSync(join(tmpdir(), 'contextflow-desktop-layout-'));
  const evidence = join(repository, 'release/product-evidence/desktop-layout'); mkdirSync(evidence, { recursive: true });
  for (const name of ['index.html', 'styles.css', 'icon.png']) copyFileSync(join(repository, 'desktop/ui', name), join(fixture, name));
  const entry = `
    import {startDesktopUI} from ${JSON.stringify(join(repository, 'desktop/ui/renderer.js'))};
    import {destinationIdentity} from ${JSON.stringify(join(repository, 'src/core/destination.js'))};
    const longPath='/Users/Example/个人知识库/项目资料与长期阅读笔记/带有空格的目录/Archive-Research-Notes-2026/Reading/Reference/LongFolderName';
    const config={translate:{provider:'openai',model:'fixture-model',baseUrl:'',apiKeySet:false,target:'简体中文',chunkChars:5000},explain:{backend:'llm'},agent:{id:'',executable:'',notesDir:'',profile:'safe',profileSource:'new-default'},sync:{backend:'markdown'},markdown:{dir:longPath,folder:'/阅读记录'},obsidian:{vaultPath:'',folder:'/阅读记录'},siyuan:{origin:'http://127.0.0.1:6806',notebookId:'',tokenSet:false},connectionChecks:{}};
    const state={version:'1.0.0',platform:'darwin',architecture:'arm64',service:{state:'running',message:'本地连接已准备好'},pairings:[],preferences:{openAtLogin:false},bridgeReady:true,packaged:true,updates:{state:'idle',message:'测试样例'},recoveryPoints:[],journey:{step:'notes',dismissed:true,notesConfirmed:false,notesVerified:false,destination:destinationIdentity(config)},discovery:{agents:{state:'done',items:[]},notes:{state:'done',items:[{backend:'obsidian',name:'项目资料与长期阅读笔记 · 测试样例',path:longPath,open:false}]}}};
    let errorMessage='测试提示';
    const api={getConfig:async()=>structuredClone(config),putConfig:async patch=>{for(const[key,value]of Object.entries(patch))config[key]={...config[key],...value};return structuredClone(config)},listFolders:async()=>({root:longPath,folders:['/阅读记录']}),listVaults:async()=>({vaults:state.discovery.notes.items}),health:async()=>({serviceVersion:'1.0.0',capabilities:['llm.draft','agent.test','connection.checks']}),detectAgents:async()=>({agents:[],connectionChecks:{}})};
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
    const {app,BrowserWindow}=require('electron');
    const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
    const fixture=${JSON.stringify(fixture)}, evidence=${JSON.stringify(evidence)};
    app.setName('ContextFlow Layout Test');app.setPath('userData',path.join(fixture,'profile'));app.disableHardwareAcceleration();
    let win;
    app.whenReady().then(async()=>{
      app.dock?.hide();
      win=new BrowserWindow({width:1280,height:900,show:false,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false,backgroundThrottling:false}});
      const issues=[];win.webContents.on('console-message',details=>{if(/Uncaught|ReferenceError|TypeError/.test(details.message||''))issues.push(details.message)});
      const evaluate=code=>win.webContents.executeJavaScript(code);
      await win.loadFile(path.join(fixture,'index.html'));await evaluate('window.layoutFixture.ready');win.show();win.focus();
      const frames=()=>evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
      async function capture(name){await frames();fs.writeFileSync(path.join(evidence,name),(await win.webContents.capturePage()).toPNG())}
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
      assert.deepEqual(issues,[]);fs.writeFileSync(path.join(evidence,'layout-report.json'),JSON.stringify({format:'ContextFlowDesktopLayout',isolated:true,serviceStarted:false,cases:reports},null,2));
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
  const timer = setTimeout(() => child.kill('SIGTERM'), 50000);
  try { const [code, signal] = await once(child, 'exit'); assert.equal(code, 0, output); assert.equal(signal, null); }
  finally { clearTimeout(timer); if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM'); }
  const report = JSON.parse(readFileSync(join(evidence, 'layout-report.json'), 'utf8'));
  assert.equal(report.cases.length, 3); assert.equal(report.serviceStarted, false);
  console.log('Electron layout evidence: '+evidence);
});
