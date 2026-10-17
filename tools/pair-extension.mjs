import { pairExtension } from '../server/extension-pairing.mjs';

try {
  const args = process.argv.slice(2);
  const revoke = args[0] === '--revoke';
  const id = args[revoke ? 1 : 0];
  if (args.length !== (revoke ? 2 : 1)) throw new Error('用法：npm run pair -- <扩展ID>，或 npm run pair -- --revoke <扩展ID>');
  const token = pairExtension(id, { revoke });
  if (revoke) console.log('已撤销该扩展的本地服务访问权限，无需重启服务。');
  else {
    console.log('请将下面的配对码粘贴到 ContextFlow 扩展自己的设置页，不要发送给他人：');
    console.log(token);
    console.log('无需重启服务；重新运行此命令会让旧配对码失效。');
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
