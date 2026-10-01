import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname, matchesGlob } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildIndex } from './write-index.mjs';

/** Lays out `{ 'kyiv/s/0.json': {...} }` under a fresh temp dir and returns its path. */
async function fixture(files) {
  const root = await mkdtemp(join(tmpdir(), 'addr-index-'));
  for (const [path, body] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), JSON.stringify(body), 'utf8');
  }
  return root;
}

test('a region without x/ files gets exactly the entry it always had', async (t) => {
  // An app that predates `lines` must see a byte-for-byte unchanged entry for such a region.
  const root = await fixture({
    'kyiv/streets.json': ['вул. Абрикосова', 'вул. Бажана'],
    'kyiv/s/0.json': { 1: 'GPV1.1', 2: 'GPV2.1' },
    'kyiv/s/1.json': { 5: 'GPV3.1' }
  });
  t.after(() => rm(root, { recursive: true, force: true }));
  assert.deepEqual(await buildIndex(root), {
    kyiv: { shape: 'flat', streets: 2, built: 2, addresses: 3 }
  });
});

test('a flat region with x/ files is marked and its multi-line houses counted', async (t) => {
  const root = await fixture({
    'kyiv/streets.json': ['вул. Абрикосова', 'вул. Бажана', 'вул. Васильківська'],
    'kyiv/s/0.json': { 93: 'GPV3.1', 95: 'GPV5.1', 97: 'GPV3.1' },
    'kyiv/s/1.json': { 5: 'GPV3.1' },
    'kyiv/x/0.json': { 93: ['GPV3.1', 'GPV5.1'], 95: ['GPV5.1', 'GPV3.1', 'GPV18.1'] }
  });
  t.after(() => rm(root, { recursive: true, force: true }));
  assert.deepEqual(await buildIndex(root), {
    kyiv: { shape: 'flat', streets: 3, built: 2, addresses: 4, lines: true, multiLine: 2 }
  });
});

test('a nested region is marked when any settlement has x/, and x-only houses are counted', async (t) => {
  // Хмельницький publishes a house on two черги in x/ only; it is not one of the s/ addresses.
  const root = await fixture({
    'khmelnytskyi/settlements.json': ['Антонівці', 'Пирогівці'],
    'khmelnytskyi/c/0/streets.json': ['вул. Польова'],
    'khmelnytskyi/c/0/s/0.json': { 1: 'GPV1.1', 2: 'GPV1.1' },
    'khmelnytskyi/c/1/streets.json': ['вул. Садова', 'вул. Центральна'],
    'khmelnytskyi/c/1/s/0.json': { 7: 'GPV2.1' },
    'khmelnytskyi/c/1/s/1.json': { 1: 'GPV1.1', 3: 'GPV1.2' },
    'khmelnytskyi/c/1/x/1.json': { 4: ['GPV1.1', 'GPV1.2'] },
    'odesa/settlements.json': ['м. Ізмаїл'],
    'odesa/c/0/streets.json': ['вул. Миру'],
    'odesa/c/0/s/0.json': { 1: 'GPV2.2' }
  });
  t.after(() => rm(root, { recursive: true, force: true }));
  assert.deepEqual(await buildIndex(root), {
    khmelnytskyi: { shape: 'nested', settlements: 2, streets: 3, built: 3, addresses: 5, lines: true, multiLine: 1 },
    odesa: { shape: 'nested', settlements: 1, streets: 1, built: 1, addresses: 1 }
  });
});

test('a rebuild in progress and the copy it replaced are not regions', async (t) => {
  // `--fresh` leaves `kyiv.new/` mid-harvest and `kyiv.old/` after the swap.
  const root = await fixture({
    'kyiv/streets.json': ['вул. Абрикосова'],
    'kyiv/s/0.json': { 1: 'GPV1.1' },
    'kyiv.new/streets.json': ['вул. Абрикосова'],
    'kyiv.new/x/0.json': { 1: ['GPV1.1', 'GPV2.1'] },
    'kyiv.old/streets.json': ['вул. Абрикосова'],
    'index.json': {}
  });
  t.after(() => rm(root, { recursive: true, force: true }));
  assert.deepEqual(Object.keys(await buildIndex(root)), ['kyiv']);
});

test('…and neither is committed or deployed', async () => {
  // Both sit under the Hosting public dir, which on its own skips only dot-files, and committing
  // the swapped-in region with `git add` on its directory would sweep them in too.
  const repo = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
  const { ignore } = JSON.parse(await readFile(join(repo, 'firebase.json'), 'utf8')).hosting;
  const deployed = (path) => !ignore.some((glob) => matchesGlob(path, glob));
  const committed = (path) => spawnSync('git', ['check-ignore', '-q', join('firebase/public', path)], { cwd: repo }).status !== 0;

  for (const path of ['v1/addr/kyiv.new/s/0.json', 'v1/addr/odesa.old/c/0/x/1.json', 'v1/addr/kyiv/s/.0.json.tmp']) {
    assert.equal(deployed(path), false, `${path} would be deployed`);
    assert.equal(committed(path), false, `${path} would be committed`);
  }
  assert.equal(deployed('v1/addr/kyiv/s/0.json'), true);
  assert.equal(committed('v1/addr/kyiv/s/0.json'), true);
});
