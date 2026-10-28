#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { inside, loadConfig } from './lib.mjs';
import { codeRabbitYaml } from './coderabbit-config.mjs';

const bundle = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
try {
  const { values } = parseArgs({ options: { root: { type: 'string' }, preview: { type: 'boolean', default: false } } });
  const root = fs.realpathSync(path.resolve(values.root || process.cwd()));
  const config = loadConfig(root);
  const artifacts = [
    ['.coderabbit.yaml', codeRabbitYaml(config.integrationBranch, config.defaultBranch)],
    ['.github/ISSUE_TEMPLATE/feature.md', fs.readFileSync(path.join(bundle, 'docs/templates/issue-feature.md'), 'utf8')],
    ['.github/ISSUE_TEMPLATE/bug.md', fs.readFileSync(path.join(bundle, 'docs/templates/issue-bug.md'), 'utf8')],
    ['.github/PULL_REQUEST_TEMPLATE.md', fs.readFileSync(path.join(bundle, 'docs/templates/pull-request.md'), 'utf8')],
  ];
  // Preflight every destination before creating anything.
  for (const [relative] of artifacts) inside(root, relative);
  const created = []; const preserved = [];
  for (const [relative, content] of artifacts) {
    const full = inside(root, relative);
    if (fs.existsSync(full)) { preserved.push({ path: relative, matches: fs.readFileSync(full, 'utf8') === content }); continue; }
    if (!values.preview) { fs.mkdirSync(path.dirname(full), { recursive: true }); fs.writeFileSync(full, content, { flag: 'wx' }); }
    created.push(relative);
  }
  console.log(JSON.stringify({ preview: values.preview, created, preserved,
    requiresManualMerge: preserved.some(item => !item.matches),
    appInstalled: 'unknown', appSetup: 'https://app.coderabbit.ai/',
    note: '설정 파일 준비만 완료. GitHub App의 실제 설치와 PR 리뷰는 별도로 확인해야 함.' }, null, 2));
} catch (error) { console.error(`GitHub 설정 오류: ${error.message}`); process.exitCode = 1; }
