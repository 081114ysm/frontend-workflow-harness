#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { githubWorkflow } from './github-lib.mjs';

try {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    root: { type: 'string' }, title: { type: 'string' }, key: { type: 'string' },
    'body-file': { type: 'string' }, existing: { type: 'string' },
  } });
  const root = fs.realpathSync(path.resolve(values.root || process.cwd()));
  if (!positionals[0] || positionals[0] === 'help') console.log('check | issue-create --key ID --title 제목 --body-file 파일 [--existing URL] | issue-sync | resume | pr-create --title 제목 --body-file 파일 | pr-inspect | issue-close');
  else console.log(JSON.stringify(githubWorkflow(root, positionals[0], values), null, 2));
} catch (error) { console.error(`GitHub 워크플로우 오류: ${error.message}`); process.exitCode = 1; }
