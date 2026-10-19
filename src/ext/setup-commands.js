// A copied setup command must not run npm in an unrelated project.
// Keep the check inside the same && chain as the operation it protects.
export const PROJECT_CHECK_CODE = "const[v,m]=process.versions.node.split('.').map(Number);if(v<22||(v===22&&m<13)){console.error('请安装 Node.js 22.13 或更高版本，再重新打开终端。');process.exit(1)}let p;try{p=require('./package.json')}catch{}if(p?.name==='contextflow'&&p?.scripts?.server==='node server/index.mjs'&&require('node:fs').existsSync('server/index.mjs')){console.log('目录确认：ContextFlow');process.exit(0)}console.error('目录不对：请先进入解压后的 ContextFlow 服务文件夹，再运行本命令。');process.exit(1)";
export const PROJECT_CHECK_COMMAND = `node -e "${PROJECT_CHECK_CODE}"`;

export function companionCommands(extensionId) {
  if (!/^[a-p]{32}$/.test(extensionId)) throw new Error('Invalid Chrome extension ID');
  const guarded = (command) => `${PROJECT_CHECK_COMMAND} && ${command}`;
  return {
    check: PROJECT_CHECK_COMMAND,
    install: guarded('npm ci --omit=dev && npm run server'),
    setup: guarded(`npm ci --omit=dev && npm run pair -- ${extensionId} && npm run server`),
    restart: guarded('npm run server'),
    service: guarded('npm run service'),
    pair: guarded(`npm run pair -- ${extensionId}`),
    revoke: guarded(`npm run pair -- --revoke ${extensionId}`),
  };
}
