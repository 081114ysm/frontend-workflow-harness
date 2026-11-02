#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { inside, ensure } from './lib.mjs';

try {
  const { values } = parseArgs({ options: { target: { type: 'string' }, host: { type: 'string', default: 'codex' } } });
  ensure(values.target && ['codex', 'claude'].includes(values.host), '사용법: node scripts/install.mjs --target 대상프로젝트 [--host codex|claude]');
  const root = fs.realpathSync(path.resolve(values.target));
  const source = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const relative = `${values.host === 'claude' ? '.claude' : '.agents'}/skills/frontend-workflow-harness`;
  const target = inside(root, relative);
  ensure(!fs.existsSync(target), '이미 설치되어 있음. 기존 파일을 덮어쓰지 않음');
  // Prepare outside the discoverable skill path; expose only a complete bundle.
  const staging = inside(root, `.frontend-workflow/install-${process.pid}`);
  ensure(!fs.existsSync(staging), '설치 임시 경로 충돌');
  fs.mkdirSync(staging, { recursive: true });
  try {
    for (const entry of ['SKILL.md', 'README.md', 'docs', 'config', 'scripts', 'tests', 'examples', '.github', '.coderabbit.yaml', 'package.json', 'LICENSE']) {
      fs.cpSync(path.join(source, entry), path.join(staging, entry), { recursive: true, errorOnExist: true, force: false });
    }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.renameSync(staging, target);
  } catch (error) { fs.rmSync(staging, { recursive: true, force: true }); throw error; }
  console.log(JSON.stringify({ installed: target, next: `node ${relative}/scripts/harness.mjs doctor`, note: '기존 AGENTS.md, CLAUDE.md, package.json, docs, 설정은 변경하지 않음' }, null, 2));
} catch (error) { console.error(`설치 오류: ${error.message}`); process.exitCode = 1; }
