import { readFileSync } from 'node:fs';

// esbuild strips dependency comments; retain licenses in every distributed UI
// bundle, including the single-file userscript (no remote assets required).
const packages = [ ['katex','LICENSE'], ['markdown-it','LICENSE'], ['markdown-it-footnote','LICENSE'],
  ['entities','LICENSE'], ['linkify-it','LICENSE'], ['mdurl','LICENSE'],
  ['punycode.js','LICENSE-MIT.txt'], ['uc.micro','LICENSE.txt'] ];

export function markdownLicenseComment() {
  const notices = packages.map(([name, license]) => {
    const root = new URL(`../node_modules/${name}/`, import.meta.url);
    const version = JSON.parse(readFileSync(new URL('package.json', root), 'utf8')).version;
    return `${name} ${version}\n${readFileSync(new URL(license, root), 'utf8').trim()}`;
  }).join('\n\n');
  return `/* Third-party Markdown and math libraries\n\n${notices.replace(/\*\//g, '* /')}\n*/`;
}
