import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
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

test('settings live in the Microphone & Detection tab', () => {
    const manifest = JSON.parse(readFileSync(path.join(root, 'plugin.json'), 'utf8'));
    assert.equal(manifest.settings.category, 'mic');
});

const mainSrc = () => readFileSync(path.join(root, 'src', 'main.js'), 'utf8');

test('main.js publishes the API from the factory', () => {
    assert.match(mainSrc(), /window\.lyricsKaraoke\s*=\s*createKaraokeApi\(/);
});

test('the voice monitor is only built through connectMonitor', () => {
    const src = mainSrc();
    assert.ok(src.includes('function connectMonitor('));
    assert.ok(src.includes('function disconnectMonitor('));
    assert.equal(src.split('micSourceNode.connect(monitorGain)').length - 1, 1);
});

test('the scorer uses the session difficulty', () => {
    const src = mainSrc();
    assert.ok(!src.includes('difficulty: getDifficulty()'));
    assert.ok(src.includes('difficulty: overrides.difficulty()'));
});

test('README documents the plugin API', () => {
    const readmePath = path.join(root, 'README.md');
    const readme = existsSync(readmePath) ? readFileSync(readmePath, 'utf8') : '';
    assert.ok(readme.includes('window.lyricsKaraoke'));
    assert.ok(readme.includes('karaoke:phrase'));
    assert.ok(readme.includes('karaoke:reset'));
});
