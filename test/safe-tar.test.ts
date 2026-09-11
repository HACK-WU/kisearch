import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import test from 'node:test';
import { extractScopeSnapshot } from '../src/lib/safe-tar.js';

test('restore 快照解压拒绝 scope 外部符号链接', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ki-safe-tar-'));
  const source = path.join(root, 'source');
  const archive = path.join(root, 'snapshot.tar.gz');
  const destination = path.join(root, 'destination');
  const scopeDir = path.join(source, 'scope-a');
  const outside = path.join(root, 'outside');
  fs.mkdirSync(scopeDir, { recursive: true });
  fs.mkdirSync(destination, { recursive: true });
  fs.mkdirSync(outside, { recursive: true });
  fs.writeFileSync(path.join(scopeDir, 'index.json'), '{}');
  fs.symlinkSync(outside, path.join(scopeDir, 'escape'), 'dir');
  execFileSync('tar', ['-czf', archive, '-C', source, 'scope-a']);

  assert.throws(
    () => extractScopeSnapshot(archive, path.join(destination, 'scope-a')),
    /链接条目/,
  );
  assert.equal(fs.existsSync(path.join(destination, 'scope-a')), false);
});
