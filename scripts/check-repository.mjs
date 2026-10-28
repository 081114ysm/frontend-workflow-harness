import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { codeRabbitYaml } from './coderabbit-config.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const skip = new Set(['.git', '.agents', '.frontend-workflow', 'node_modules']);
function walk(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    if (skip.has(entry.name) || entry.isSymbolicLink()) return [];
    const full = path.join(directory, entry.name);
    return entry.isDirectory() ? walk(full) : [full];
  });
}

const files = walk(root); let links = 0; let json = 0; let scripts = 0;
for (const file of files) {
  if (file.endsWith('.json')) { JSON.parse(fs.readFileSync(file, 'utf8')); json++; }
  if (file.endsWith('.mjs')) {
    const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr); scripts++;
  }
  if (!file.endsWith('.md')) continue;
  const content = fs.readFileSync(file, 'utf8').replace(/```[\s\S]*?```/g, '');
  for (const match of content.matchAll(/\[[^\]]*\]\(([^\s)]+)(?:\s+"[^"]*")?\)/g)) {
    const href = match[1];
    if (/^(https?:|mailto:|#)/.test(href)) continue;
    const relative = decodeURIComponent(href.split('#')[0]);
    assert(fs.existsSync(path.resolve(path.dirname(file), relative)), `끊어진 문서 링크: ${path.relative(root, file)} → ${href}`);
    links++;
  }
}
for (const file of ['SKILL.md', 'LICENSE', 'README.md', 'scripts/harness.mjs', 'scripts/install.mjs', 'config/project.example.json', 'docs/templates/feature-plan.md']) {
  assert(fs.existsSync(path.join(root, file)), `배포 필수 파일 누락: ${file}`);
}
const skill = fs.readFileSync(path.join(root, 'SKILL.md'), 'utf8');
assert(/^---\nname: frontend-workflow-harness\ndescription: .+\nlicense: MIT\n---/.test(skill), '스킬 frontmatter 확인');
assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'config/project.example.json'))).configured, false, '설정 예시는 자동 활성화하면 안 됨');
assert.equal(fs.readFileSync(path.join(root, '.coderabbit.yaml'), 'utf8'), codeRabbitYaml('main', 'main'), 'CodeRabbit 배포 설정과 생성 원본이 다름');
for (const [canonical, github] of [
  ['docs/templates/issue-feature.md', '.github/ISSUE_TEMPLATE/feature.md'],
  ['docs/templates/issue-bug.md', '.github/ISSUE_TEMPLATE/bug.md'],
  ['docs/templates/pull-request.md', '.github/PULL_REQUEST_TEMPLATE.md'],
]) {
  assert.equal(fs.readFileSync(path.join(root, canonical), 'utf8'), fs.readFileSync(path.join(root, github), 'utf8'), `GitHub 템플릿 불일치: ${github}`);
}
console.log(JSON.stringify({ status: 'passed', localLinks: links, jsonFiles: json, syntaxChecked: scripts }, null, 2));
