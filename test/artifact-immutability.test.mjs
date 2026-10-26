import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, copyFileSync, existsSync, statSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { desktopBuildPaths, stageDesktopArtifacts } from '../tools/package-desktop.mjs';

function extensionFixture() {
  const root=mkdtempSync(join(tmpdir(),'contextflow-immutable-extension-'));
  mkdirSync(join(root,'tools'));mkdirSync(join(root,'release'));
  writeFileSync(join(root,'package.json'),JSON.stringify({type:'module',version:'1.1.0'}));
  for(const name of ['package-extension.mjs','artifact-output.mjs']) {
    const source=new URL(`../tools/${name}`,import.meta.url);
    if(existsSync(source)) copyFileSync(source,join(root,'tools',name));
  }
  writeFileSync(join(root,'revision'),'same-source');
  writeFileSync(join(root,'tools','build.mjs'),`
    import {mkdirSync,writeFileSync,readFileSync,chmodSync,utimesSync} from 'node:fs';
    import {join} from 'node:path';
    const output=process.env.CONTEXTFLOW_EXT_DIR;mkdirSync(output,{recursive:true});
    const revision=readFileSync(new URL('../revision',import.meta.url),'utf8');
    for(const name of ['app.js','sw.js','options.js','options.html','options.css','privacy.html','manifest.json','toolbar-16.png','toolbar-32.png','toolbar-48.png','toolbar-128.png']) {
      const file=join(output,name);writeFileSync(file,name==='manifest.json' ? JSON.stringify({manifest_version:3,version:'1.1.0'}) : revision+' '+name);
      chmodSync(file,process.env.FIXTURE_VARIATION==='two' ? 0o600 : 0o644);
      utimesSync(file,new Date(process.env.FIXTURE_VARIATION==='two' ? '2025-02-01T01:00:00Z' : '2024-01-01T00:00:00Z'),new Date());
    }
  `);
  return {root,run:(args=[],variation='one')=>execFileSync(process.execPath,[join(root,'tools','package-extension.mjs'),...args],
    {cwd:root,env:{...process.env,FIXTURE_VARIATION:variation},encoding:'utf8',stdio:'pipe'}),
    close:()=>rmSync(root,{recursive:true,force:true})};
}

test('default extension packaging cannot overwrite a frozen same-version ZIP or its checksum',()=>{
  const f=extensionFixture();
  try {
    const archive=join(f.root,'release','contextflow-chrome-1.1.0.zip'),checksum=`${archive}.sha256`;
    writeFileSync(archive,'frozen ZIP');writeFileSync(checksum,'frozen checksum');
    assert.throws(()=>f.run(),/不可覆盖|已存在|冲突/);
    assert.equal(readFileSync(archive,'utf8'),'frozen ZIP');assert.equal(readFileSync(checksum,'utf8'),'frozen checksum');
    assert.deepEqual(readdirSync(join(f.root,'release')).sort(),['contextflow-chrome-1.1.0.zip','contextflow-chrome-1.1.0.zip.sha256']);
  } finally { f.close(); }
});

test('extension output directories are isolated; timestamps and permissions cannot change identical ZIP bytes',()=>{
  const f=extensionFixture();
  try {
    const defaultArchive=join(f.root,'release','contextflow-chrome-1.1.0.zip');writeFileSync(defaultArchive,'frozen ZIP');
    f.run(['--output-dir','release/local-validation']);
    const archive=join(f.root,'release','local-validation','contextflow-chrome-1.1.0.zip'),before=readFileSync(archive),checksum=readFileSync(`${archive}.sha256`),mtime=statSync(archive).mtimeMs;
    f.run(['--output-dir','release/local-validation'],'two');
    assert.deepEqual(readFileSync(archive),before);assert.deepEqual(readFileSync(`${archive}.sha256`),checksum);
    assert.equal(statSync(archive).mtimeMs,mtime,'an identical package is reused, never rewritten');
    assert.equal(readFileSync(defaultArchive,'utf8'),'frozen ZIP');
    writeFileSync(join(f.root,'revision'),'changed-source');
    assert.throws(()=>f.run(['--output-dir','release/local-validation']),/不可覆盖|已存在|冲突/);
    assert.deepEqual(readFileSync(archive),before);assert.deepEqual(readFileSync(`${archive}.sha256`),checksum);
    assert.equal(readdirSync(join(f.root,'release','local-validation')).some(name=>name.endsWith('.tmp')),false);
  } finally { f.close(); }
});

test('extension checksum conflicts and symlink destinations fail before publishing any new attachment',()=>{
  const f=extensionFixture(),outside=mkdtempSync(join(tmpdir(),'contextflow-immutable-outside-'));
  try {
    const destination=join(f.root,'release','checksum-conflict');mkdirSync(destination);
    const archive=join(destination,'contextflow-chrome-1.1.0.zip');writeFileSync(`${archive}.sha256`,'old sha');
    assert.throws(()=>f.run(['--output-dir','release/checksum-conflict']),/不可覆盖|已存在|冲突/);
    assert.equal(existsSync(archive),false);assert.equal(readFileSync(`${archive}.sha256`,'utf8'),'old sha');
    for(const args of [['--output-dir','../outside'],['--output-dir',outside],['--output-dir'],['--publish','always'],['--output-dir','release/a','--output-dir','release/b']]) assert.throws(()=>f.run(args));
    if(process.platform!=='win32') {
      symlinkSync(outside,join(f.root,'release','linked-directory'));
      assert.throws(()=>f.run(['--output-dir','release/linked-directory']),/符号链接/);assert.deepEqual(readdirSync(outside),[]);
      const broken=join(f.root,'release','broken');mkdirSync(broken);
      symlinkSync(join(outside,'missing'),join(broken,'contextflow-chrome-1.1.0.zip'));
      assert.throws(()=>f.run(['--output-dir','release/broken']),/符号链接|普通文件/);
      assert.deepEqual(readdirSync(broken),['contextflow-chrome-1.1.0.zip']);
    }
  } finally { f.close();rmSync(outside,{recursive:true,force:true}); }
});

test('desktop preflights the entire installer, blockmap and checksum set without leaving half a release',()=>{
  const root=mkdtempSync(join(tmpdir(),'contextflow-immutable-desktop-')),paths=desktopBuildPaths(root,'candidate');
  mkdirSync(paths.staging,{recursive:true});mkdirSync(paths.artifacts,{recursive:true});
  try {
    const first=join(paths.staging,'ContextFlow-1.1.0-mac-arm64.dmg'),second=join(paths.staging,'ContextFlow-1.1.0-win-x64.exe');
    const blockmap=`${second}.blockmap`;
    writeFileSync(first,'new DMG');writeFileSync(second,'new EXE');
    const frozen=join(paths.artifacts,'ContextFlow-1.1.0-win-x64.exe');writeFileSync(frozen,'frozen EXE');writeFileSync(`${frozen}.sha256`,'frozen sha');
    assert.throws(()=>stageDesktopArtifacts([first,second],paths),/不可覆盖|已存在|冲突/);
    assert.equal(existsSync(join(paths.artifacts,'ContextFlow-1.1.0-mac-arm64.dmg')),false);
    assert.equal(readFileSync(frozen,'utf8'),'frozen EXE');assert.equal(readFileSync(`${frozen}.sha256`,'utf8'),'frozen sha');
    rmSync(frozen);rmSync(`${frozen}.sha256`);
    writeFileSync(`${frozen}.sha256`,'checksum conflict');
    assert.throws(()=>stageDesktopArtifacts([first,second],paths),/不可覆盖|已存在|冲突/);
    assert.deepEqual(readdirSync(paths.artifacts),['ContextFlow-1.1.0-win-x64.exe.sha256']);
    rmSync(`${frozen}.sha256`);
    writeFileSync(blockmap,'new blockmap');writeFileSync(`${frozen}.blockmap`,'frozen blockmap');
    assert.throws(()=>stageDesktopArtifacts([first,second,blockmap],paths),/不可覆盖|已存在|冲突/);
    assert.deepEqual(readdirSync(paths.artifacts),['ContextFlow-1.1.0-win-x64.exe.blockmap']);
    assert.equal(readFileSync(`${frozen}.blockmap`,'utf8'),'frozen blockmap');rmSync(`${frozen}.blockmap`);
    writeFileSync(join(paths.staging,'latest.yml'),JSON.stringify({path:'ContextFlow-1.1.0-win-x64.exe'}));
    writeFileSync(join(paths.artifacts,'latest.yml'),'frozen metadata');
    assert.throws(()=>stageDesktopArtifacts([first,second,blockmap],{...paths,parseMetadata:JSON.parse}),/不可覆盖|已存在|冲突/);
    assert.deepEqual(readdirSync(paths.artifacts),['latest.yml']);rmSync(join(paths.artifacts,'latest.yml'));
    const output=stageDesktopArtifacts([first,second,blockmap],{...paths,parseMetadata:JSON.parse}),snapshot=output.map(file=>readFileSync(file)),mtimes=output.map(file=>statSync(file).mtimeMs);
    assert.deepEqual(stageDesktopArtifacts([first,second,blockmap],{...paths,parseMetadata:JSON.parse}),output);
    assert.deepEqual(output.map(file=>readFileSync(file)),snapshot);assert.deepEqual(output.map(file=>statSync(file).mtimeMs),mtimes);
    if(process.platform!=='win32') {
      rmSync(`${frozen}.sha256`);symlinkSync(join(root,'missing'),`${frozen}.sha256`);
      assert.throws(()=>stageDesktopArtifacts([first,second],paths),/符号链接|普通文件/);
      assert.deepEqual(readFileSync(frozen),Buffer.from('new EXE'));
    }
  } finally { rmSync(root,{recursive:true,force:true}); }
});
