import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parsePosts, parseGpvPost, scheduleFromPosts } from './lib/telegram.mjs';
import { tablesOf, withBranchQueues, branchKey } from './sources/cherkasy.mjs';

// @pat_cherkasyoblenergo as it stood on 19 November 2026 at 09:45: posts 2017–2036. From 17 November the day's post carries two
// tables — the region's, and «тимчасові індивідуальні графіки» of four branches in Уманський район — with the same queue labels.
const posts = parsePosts(readFileSync(new URL('./cherkasy.fixture-2026-11-19.html', import.meta.url), 'utf8'), 'pat_cherkasyoblenergo');
const post = (id) => posts.find((p) => p.id === id);
const NOV18 = 1794952800, NOV19 = 1795039200;   // midnight in Kyiv
const dark = (hours) => Object.entries(hours).filter(([, state]) => state !== 'yes').map(([hour]) => +hour).sort((a, b) => a - b);

const tables = posts.map(tablesOf);
const regionPosts = tables.map((t) => t.region).filter(Boolean);
const branchPosts = tables.map((t) => t.branches).filter(Boolean);

test('the region\'s queues keep the region\'s hours, not the two tables added up', () => {
  const { fact } = scheduleFromPosts(regionPosts, { since: NOV18 });
  // «2.2 11:00 - 13:00, 17:00 - 19:00, 23:00 - 24:00» — read with the branches' row it was sixteen hours.
  assert.deepEqual(dark(fact[NOV19]['GPV2.2']), [12, 13, 18, 19, 24]);
  assert.deepEqual(dark(fact[NOV19]['GPV1.2']), [7, 8, 18, 19, 24]);
  assert.deepEqual(dark(fact[NOV19]['GPV4.2']), [9, 10, 15, 16, 20, 21]);
  assert.deepEqual(dark(fact[NOV19]['GPV6.2']), [11, 12, 16, 17, 22, 23]);
  // The queues the branches' table does not name were right all along.
  assert.deepEqual(dark(fact[NOV19]['GPV2.1']), [7, 8, 17, 18, 23, 24]);
  // And the day before, whose post was the first with two tables: «2.2 06:00 - 08:00, 12:00 - 15:00, 18:00 - 21:00».
  assert.deepEqual(dark(fact[NOV18]['GPV2.2']), [7, 8, 13, 14, 15, 19, 20, 21]);
});

test('the read that added the tables up is what this replaces', () => {
  const { fact } = scheduleFromPosts(posts, { since: NOV18 });
  assert.deepEqual(dark(fact[NOV19]['GPV2.2']), [1, 2, 3, 7, 8, 9, 12, 13, 14, 15, 18, 19, 20, 21, 24]);
});

test('the branches\' table becomes queues of their own beside the region\'s', () => {
  const { fact } = scheduleFromPosts(regionPosts, { since: NOV18 });
  const snapshot = withBranchQueues({ fact: { data: fact }, preset: { sch_names: { 'GPV2.2': 'Черга 2.2' } } }, branchPosts, { since: NOV18 });
  const names = snapshot.preset.sch_names;
  assert.deepEqual(Object.keys(names).filter((key) => key.startsWith('GPV100')).sort(),
    ['GPV1001.2', 'GPV1002.2', 'GPV1003.2', 'GPV1004.2', 'GPV1005.2', 'GPV1006.2']);
  assert.equal(names['GPV1002.2'], 'Уманщина 2.2');
  assert.equal(names['GPV2.2'], 'Черга 2.2');
  // «2.2 00:00 - 03:00, 06:00 - 09:00, 12:00 - 15:00, 18:00 - 21:00»
  assert.deepEqual(dark(snapshot.fact.data[NOV19][branchKey('2.2')]), [1, 2, 3, 7, 8, 9, 13, 14, 15, 19, 20, 21]);
  // «4.2 03:00 - 06:00, 09:00 - 12:00, 15:00 - 18:00, 21:00 - 24:00»
  assert.deepEqual(dark(snapshot.fact.data[NOV19][branchKey('4.2')]), [4, 5, 6, 10, 11, 12, 16, 17, 18, 22, 23, 24]);
  assert.deepEqual(dark(snapshot.fact.data[NOV18][branchKey('2.2')]), [1, 2, 3, 7, 8, 9, 13, 14, 15, 19, 20, 21]);
  // The region's own row is untouched by it.
  assert.deepEqual(dark(snapshot.fact.data[NOV19]['GPV2.2']), [12, 13, 18, 19, 24]);
});

test('a post with one table is the region\'s, whole', () => {
  // 2027, 16 November: the last day's post before the branches had a table of their own.
  const { region, branches } = tablesOf(post(2027));
  assert.equal(region, post(2027));
  assert.equal(branches, null);
});

test('the branches\' table posted alone is not the region\'s', () => {
  // 2028, 17 November 09:08: «… в частині Уманського району … застосовуються тимчасові індивідуальні графіки», six rows, no date.
  const { region, branches } = tablesOf(post(2028));
  assert.equal(region, null);
  assert.equal(branches, post(2028));
  assert.equal(parseGpvPost(branches), null);   // it names no day, so it sets none

  // The same with a day in it would otherwise have switched every x.1 of the region on from the minute it went out.
  const dated = { ...post(2028), id: 9001, text: post(2028).text.replace('застосовуються', '19 листопада застосовуються') };
  assert.equal(tablesOf(dated).region, null);
  assert.deepEqual(dark(parseGpvPost(tablesOf(dated).branches).queues['GPV2.2']), [7, 8, 9, 13, 14, 15, 19, 20, 21]);
});

test('the region\'s table stays the region\'s when only its preface speaks of the branches', () => {
  const lines = post(2035).text.split('\n');
  const second = lines.findIndex((line, index) => index > 10 && /індивідуальн/.test(line));
  const onlyRegion = { ...post(2035), id: 9002, text: lines.slice(0, second).join('\n').replace(/\s*по області \(крім[^)]*\)/, '') };
  assert.match(onlyRegion.text, /індивідуальні графіки/);       // the preface still says so
  assert.doesNotMatch(onlyRegion.text, /по області/);
  const { region, branches } = tablesOf(onlyRegion);
  assert.equal(region, onlyRegion);
  assert.equal(branches, null);
});

test('on a day whose post has no table of theirs the branches follow the region\'s row', () => {
  const NOV20 = NOV19 + 86400;
  const { fact } = scheduleFromPosts(regionPosts, { since: NOV18 });
  const data = { ...fact, [NOV20]: { 'GPV2.2': { ...fact[NOV19]['GPV2.2'], 1: 'no' } } };
  const snapshot = withBranchQueues({ fact: { data }, preset: { sch_names: {} } }, branchPosts, { since: NOV18 });
  assert.deepEqual(snapshot.fact.data[NOV20][branchKey('2.2')], data[NOV20]['GPV2.2']);
});

test('with no such table in reach nothing is added', () => {
  const { fact } = scheduleFromPosts(regionPosts, { since: NOV18 });
  const snapshot = { fact: { data: fact }, preset: { sch_names: {} } };
  assert.equal(withBranchQueues(snapshot, []), snapshot);
  // The branches' tables are for days the snapshot no longer holds.
  const later = { fact: { data: { [NOV19 + 5 * 86400]: { 'GPV2.2': {} } } }, preset: { sch_names: {} } };
  assert.equal(withBranchQueues(later, branchPosts, { since: NOV18 }), later);
  // An empty day list is ДТЕК's `[]`, not an object.
  const empty = { fact: { data: [] }, preset: { sch_names: {} } };
  assert.equal(withBranchQueues(empty, branchPosts, { since: NOV18 }), empty);
});
