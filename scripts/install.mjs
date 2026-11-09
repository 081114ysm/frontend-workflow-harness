#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { inside, ensure, sha, readJson, withLock, writeJson } from './lib.mjs';

const ENTRIES = ['SKILL.md', 'README.md', 'docs', 'config', 'scripts', 'tests', 'examples', '.github', '.coderabbit.yaml', 'package.json', 'LICENSE'];
const OPTIONAL = ['package-lock.json', 'THIRD_PARTY_NOTICES.md'];
const MANIFEST = '.harness-install.json';

/** 번들에 포함된 일반 파일만 해시한다. 설치 경로의 링크는 거부한다. */
function inventory(root, entries) {
  const files = Object.create(null);
  const visit = relative => {
    const full = path.join(root, relative);
    const stat = fs.lstatSync(full);
    ensure(stat.isDirectory() || stat.isFile(), '설치 영역에는 일반 파일과 디렉터리만 허용: ' + relative);
    if (stat.isDirectory()) {
      for (const name of fs.readdirSync(full).sort()) visit(relative + '/' + name);
    } else files[relative] = sha(fs.readFileSync(full));
  };
  for (const name of entries) visit(name);
  return files;
}

/** 1.0 설치본의 기준에는 당시 설치기가 복사한 파일만 포함한다. */
function bundleAt(root, legacyBaseline = false) {
  const pkg = readJson(inside(root, 'package.json'));
  ensure(pkg.name === 'frontend-workflow-harness' && /^\d+\.\d+\.\d+$/.test(pkg.version || ''), '버전이 있는 하네스 번들 필요');
  const entries = legacyBaseline && /^1\.0\./.test(pkg.version)
    ? ENTRIES
    : [...ENTRIES, ...OPTIONAL.filter(name => fs.existsSync(inside(root, name)))];
  return { version: pkg.version, files: inventory(root, entries) };
}

/** major, minor, patch를 숫자로 비교해 다운그레이드를 검출한다. */
function orderVersion(a, b) {
  const left = a.split('.').map(Number);
  const right = b.split('.').map(Number);
  return left[0] - right[0] || left[1] - right[1] || left[2] - right[2];
}

/** 설치본·기준·새 번들의 해시를 대조하고 충돌을 확인한다. 디스크는 변경하지 않는다. */
function updatePlan(target, next, baseline) {
  const current = inventory(target, fs.readdirSync(target).sort());
  const previous = Object.hasOwn(current, MANIFEST)
    ? readJson(path.join(target, MANIFEST)) : baseline ? bundleAt(baseline, true) : null;
  ensure(previous && /^\d+\.\d+\.\d+$/.test(previous.version || '') && previous.files && typeof previous.files === 'object' && !Array.isArray(previous.files)
    && Object.hasOwn(previous.files, 'package.json') && Object.hasOwn(previous.files, 'SKILL.md'), '기존 설치 매니페스트가 없음. 설치 당시 원본을 --baseline으로 지정');
  ensure(readJson(path.join(target, 'package.json')).version === previous.version, '기존 설치 버전과 기준 번들이 일치하지 않음');
  for (const [name, digest] of Object.entries(previous.files)) {
    ensure(Object.hasOwn(current, name) && current[name] === digest, '설치 후 수정되거나 사라진 관리 파일: ' + name);
  }
  const preserved = Object.keys(current).filter(name => name !== MANIFEST && !Object.hasOwn(previous.files, name));
  const nextNames = Object.keys(next.files);
  for (const name of preserved) {
    ensure(!nextNames.some(file => file === name || file.startsWith(name + '/') || name.startsWith(file + '/')), '사용자 파일과 새 설치 경로 충돌: ' + name);
  }
  const added = nextNames.filter(name => !Object.hasOwn(previous.files, name));
  const changed = nextNames.filter(name => Object.hasOwn(previous.files, name) && next.files[name] !== previous.files[name]);
  const removed = Object.keys(previous.files).filter(name => !Object.hasOwn(next.files, name));
  const order = orderVersion(next.version, previous.version);
  ensure(order >= 0 && (order > 0 || !added.length && !changed.length && !removed.length), '설치된 버전보다 새 릴리스로만 내용 변경 가능');
  return { previous: previous.version, next: next.version, added, changed, removed, preserved,
    current, noop: order === 0 && Object.hasOwn(current, MANIFEST) };
}

/** 준비 디렉터리에 지정 파일을 복사한다. 같은 경로를 덮어쓰지 않는다. */
function copyFiles(source, target, files) {
  for (const name of files) {
    const destination = path.join(target, name);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(path.join(source, name), destination, fs.constants.COPYFILE_EXCL);
  }
}

/** 중단된 교체가 남긴 백업을 확인하고 설치 경로가 비었을 때만 복구한다. */
function recoverSwap(root, target, journal) {
  const record = fs.lstatSync(journal, { throwIfNoEntry: false });
  if (!record) return false;
  ensure(record.isFile() && fs.realpathSync(journal) === journal, '교체 복구 기록은 일반 파일이어야 함');
  const { backupName, stagingName } = readJson(journal);
  ensure(/^install-backup-[a-zA-Z0-9]{6}$/.test(backupName) && /^install-stage-[a-zA-Z0-9]{6}$/.test(stagingName), '교체 복구 기록 형식 오류');
  const backup = inside(root, `.frontend-workflow/runtime/${backupName}/bundle`);
  const staging = inside(root, `.frontend-workflow/runtime/${stagingName}`);
  const installed = fs.lstatSync(target, { throwIfNoEntry: false });
  ensure(!installed || installed.isDirectory(), '기존 설치 경로가 바뀌어 교체를 복구할 수 없음');
  if (!installed) {
    ensure(fs.lstatSync(backup, { throwIfNoEntry: false })?.isDirectory() && fs.realpathSync(backup) === backup, '교체 복구용 기존 번들을 찾을 수 없음');
    fs.renameSync(backup, target);
  }
  const staged = fs.lstatSync(staging, { throwIfNoEntry: false });
  if (staged) {
    ensure(staged.isDirectory() && fs.realpathSync(staging) === staging, '교체 준비 디렉터리가 바뀜');
    fs.rmSync(staging, { recursive: true });
  }
  fs.unlinkSync(journal);
  return !installed;
}

/** 검증된 새 번들을 한 번에 노출하고 교체 실패 시 이전 번들로 복구한다. */
function applyPlan(root, source, target, next, updates, journal) {
  const { current, ...details } = updates;
  if (updates.noop) return { installed: target, ...details };
  const runtime = inside(root, '.frontend-workflow/runtime');
  fs.mkdirSync(runtime, { recursive: true });
  const staging = fs.mkdtempSync(path.join(runtime, 'install-stage-'));
  let backup;
  try {
    copyFiles(source, staging, Object.keys(next.files));
    copyFiles(target, staging, updates.preserved);
    writeJson(path.join(staging, MANIFEST), next);
    const staged = inventory(staging, Object.keys(next.files));
    ensure(Object.keys(next.files).every(name => staged[name] === next.files[name]), '업데이트 중 배포 원본이 변경됨');
    fs.mkdirSync(path.dirname(target), { recursive: true });
    if (current) {
      const latest = inventory(target, fs.readdirSync(target).sort());
      ensure(JSON.stringify(latest) === JSON.stringify(current), '업데이트 중 설치본이 변경됨');
      backup = path.join(fs.mkdtempSync(path.join(runtime, 'install-backup-')), 'bundle');
      writeJson(journal, { backupName: path.basename(path.dirname(backup)), stagingName: path.basename(staging) });
      fs.renameSync(target, backup);
    } else ensure(!fs.lstatSync(target, { throwIfNoEntry: false }), '설치 중 대상 경로가 생김');
    try { fs.renameSync(staging, target); }
    catch (error) {
      if (backup && !fs.existsSync(target)) {
        try { fs.renameSync(backup, target); }
        catch { throw new Error('교체 실패. 기존 설치본 백업: ' + backup); }
      }
      throw error;
    }
    if (backup) fs.unlinkSync(journal);
    return { installed: target, ...details, backup: backup ?? null };
  } finally { fs.rmSync(staging, { recursive: true, force: true }); }
}

try {
  const { values } = parseArgs({ options: { target: { type: 'string' }, host: { type: 'string', default: 'codex' },
    update: { type: 'boolean' }, 'dry-run': { type: 'boolean' }, baseline: { type: 'string' } } });
  ensure(values.target && ['codex', 'claude'].includes(values.host), '사용법: node scripts/install.mjs --target 대상프로젝트 [--host codex|claude] [--update --dry-run --baseline 기존번들]');
  const root = fs.realpathSync(path.resolve(values.target));
  const source = fs.realpathSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'));
  const relative = (values.host === 'claude' ? '.claude' : '.agents') + '/skills/frontend-workflow-harness';
  const target = inside(root, relative);
  const journal = inside(root, `.frontend-workflow/runtime/install-swap-${values.host}.json`);
  ensure(source !== target && !source.startsWith(target + path.sep), '업데이트할 설치본과 다른 배포 원본에서 실행');
  ensure(!values.baseline || values.update, '--baseline은 --update에서만 사용');
  const next = bundleAt(source);
  const baseline = values.baseline ? fs.realpathSync(path.resolve(values.baseline)) : null;
  const plan = () => {
    const existing = fs.lstatSync(target, { throwIfNoEntry: false });
    if (!existing) {
      ensure(!values.update, '업데이트할 설치본이 없음');
      return { previous: null, next: next.version, added: Object.keys(next.files), changed: [], removed: [], preserved: [] };
    }
    ensure(values.update && existing.isDirectory(), '이미 설치되어 있음. 업데이트는 --update 사용');
    return updatePlan(target, next, baseline);
  };
  let result;
  if (values['dry-run']) {
    ensure(!fs.lstatSync(journal, { throwIfNoEntry: false }), '미완료 교체가 있음. 실제 --update로 복구한 뒤 미리보기 가능');
    const { current, ...details } = plan();
    result = { dryRun: true, target, ...details };
  } else result = withLock(root, () => {
    ensure(values.update || !fs.lstatSync(journal, { throwIfNoEntry: false }), '미완료 교체가 있음. --update로 복구');
    const recovered = recoverSwap(root, target, journal);
    return { ...applyPlan(root, source, target, next, plan(), journal), ...(recovered ? { recovered: true } : {}) };
  });
  console.log(JSON.stringify(result, null, 2));
} catch (error) { console.error('설치 오류: ' + error.message); process.exitCode = 1; }
