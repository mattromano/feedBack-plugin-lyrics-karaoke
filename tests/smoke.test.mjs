import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

test('screen.js is the one-line module entry', () => {
    assert.equal(readFileSync(path.join(root, 'screen.js'), 'utf8'), "import './src/main.js';\n");
});

test('src/main.js parses as a module', () => {
    const r = spawnSync(process.execPath, ['--check', path.join(root, 'src', 'main.js')], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
});
