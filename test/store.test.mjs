import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, statSync, readdirSync } from 'node:fs';
import { createStore } from '../lib/store.js';
import { PNG, WAV, tempDir } from './helpers.mjs';

test('add, list, get, remove', () => {
  const { dir, done } = tempDir();
  try {
    let t = 1000;
    const store = createStore({ dir, now: () => t++ });
    const a = store.add({ bytes: PNG, mime: 'image/png', prompt: 'a', model: 'm', width: 1, height: 1 });
    const b = store.add({ bytes: PNG, mime: 'image/jpeg', prompt: 'b', model: 'm' });
    assert.match(a.id, /^[a-f0-9]{12}$/);
    assert.deepEqual(store.list().items.map((i) => i.prompt), ['b', 'a']);
    assert.equal(store.get(a.id).bytes.length, PNG.length);
    assert.ok(store.pathOf(b).endsWith('.jpg'));
    assert.equal(statSync(store.pathOf(a)).mode & 0o777, 0o600, 'files are private');
    assert.equal(store.remove(a.id), true);
    assert.equal(existsSync(store.pathOf(a)), false);
    assert.equal(store.remove(a.id), false);
  } finally { done(); }
});

test('keep prunes the oldest files too', () => {
  const { dir, done } = tempDir();
  try {
    const store = createStore({ dir, keep: 2 });
    const ids = [1, 2, 3].map((n) => store.add({ bytes: PNG, mime: 'image/png', prompt: String(n), model: 'm' }));
    assert.equal(store.list().items.length, 2);
    assert.equal(store.get(ids[0].id), undefined);
    assert.equal(readdirSync(`${dir}/files`).length, 2);
  } finally { done(); }
});

test('ids are validated, so no path can escape', () => {
  const { dir, done } = tempDir();
  try {
    const store = createStore({ dir });
    for (const bad of ['../x', '..', 'a'.repeat(11), 'g'.repeat(12), '/etc/passwd', undefined, null, 42]) {
      assert.equal(store.get(bad), undefined);
      assert.equal(store.remove(bad), false);
      assert.equal(store.pathFor(bad), undefined);
    }
  } finally { done(); }
});

test('countSince counts a time window', () => {
  const { dir, done } = tempDir();
  try {
    let t = 0;
    const store = createStore({ dir, now: () => t });
    t = 100; store.add({ bytes: PNG, mime: 'image/png', prompt: 'a', model: 'm' });
    t = 200; store.add({ bytes: PNG, mime: 'image/png', prompt: 'b', model: 'm' });
    assert.equal(store.countSince(150), 1);
    assert.equal(store.countSince(0), 2);
  } finally { done(); }
});

test('a broken index is treated as empty, not as a crash', async () => {
  const { dir, done } = tempDir();
  try {
    const { writeFileSync } = await import('node:fs');
    const store = createStore({ dir });
    writeFileSync(`${dir}/index.json`, '{not json');
    assert.deepEqual(store.list().items, []);
    assert.ok(store.add({ bytes: PNG, mime: 'image/png', prompt: 'a', model: 'm' }).id);
  } finally { done(); }
});

test('addAudio keeps only the newest 50 WAVs', () => {
  const { dir, done } = tempDir();
  try {
    const store = createStore({ dir });
    let last;
    for (let i = 0; i < 53; i++) last = store.addAudio(WAV);
    assert.ok(existsSync(last));
    assert.ok(readdirSync(`${dir}/speech`).length <= 50);
  } finally { done(); }
});
