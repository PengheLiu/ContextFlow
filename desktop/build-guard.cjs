const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { Arch } = require('builder-util');

module.exports = async function beforePack(context) {
  const target = JSON.parse(fs.readFileSync(path.join(__dirname, 'build', 'target.json'), 'utf8'));
  if (target.platform !== context.electronPlatformName || target.arch !== Arch[context.arch]) {
    throw new Error(`运行时目标不匹配：请先为 ${context.electronPlatformName}-${Arch[context.arch]} 执行 desktop:prepare。`);
  }
  const root = path.dirname(__dirname);
  if (target.channel === 'release') context.packager.config.forceCodeSigning = true;
  for (const [file, expected] of Object.entries(target.sources || {})) {
    const actual = crypto.createHash('sha256').update(fs.readFileSync(path.join(root, file))).digest('hex');
    if (actual !== expected) throw new Error(`源码已变化，请重新运行 desktop:prepare：${file}`);
  }
};
