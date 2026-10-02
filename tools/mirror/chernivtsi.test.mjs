import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parsePage, publishable, fetchRegion, QUEUES } from './sources/chernivtsi.mjs';
import { kyivDayStart, validate } from './lib/canonical.mjs';

// Real pages of oblenergo.cv.ua/shutdowns/: in-season ones from the Wayback Machine's raw copies,
// the off-season one from the Kyiv server on 2026-10-01.
const page = (name) => readFileSync(new URL(`./chernivtsi.fixture-${name}.html`, import.meta.url), 'utf8');
const day = (iso) => kyivDayStart(new Date(`${iso}T12:00:00Z`));
const quiet = (fn) => { const warn = console.warn; console.warn = () => {}; try { return fn(); } finally { console.warn = warn; } };

test('08.04.2026: only groups 10 and 11, out 11:00–13:00, then a «можливо заживлені» half-hour', () => {
  const result = publishable(parsePage(page('2026-04-08')), new Date('2026-04-08T09:01:35Z'));
  assert.equal(result.day, day('2026-04-08'));
  for (const key of Object.keys(QUEUES)) {
    const hours = result.hours[key];
    if (key === 'CV10' || key === 'CV11') {
      assert.equal(hours['12'], 'no');
      assert.equal(hours['13'], 'no');
      assert.equal(hours['14'], 'mfirst');
      assert.equal(Object.values(hours).filter((state) => state !== 'yes').length, 3, key);
    } else {
      assert.ok(Object.values(hours).every((state) => state === 'yes'), key);
    }
  }
});

test('the cell counts of a heavy day add up to what the page holds', () => {
  const parsed = parsePage(page('2025-11-12'));
  const count = (state) => parsed.groups.flat().filter((s) => s === state).length;
  assert.deepEqual([count('off'), count('possible'), count('on')], [267, 51, 258]);
  assert.equal(parsed.next, day('2025-11-13'));
});

test('a table is today\'s by the Kyiv date: 00:19 on 17.02 is already the 17th', () => {
  const parsed = parsePage(page('2026-02-17'));
  assert.equal(publishable(parsed, new Date('2026-02-16T22:19:29Z')).day, day('2026-02-17'));
  // The same table the next morning is yesterday's, and is not published.
  assert.equal(publishable(parsed, new Date('2026-02-18T08:00:00Z')), null);
});

test('a schedule the operator has switched off is not published, nor a table of nothing but «з»', () => {
  assert.equal(quiet(() => publishable(parsePage(page('2026-02-15-hidden')), new Date('2026-02-15T07:04:09Z'))), null);
  assert.equal(quiet(() => publishable(parsePage(page('2026-10-01-offseason')), new Date('2026-10-01T15:03:57Z'))), null);
});

test('the old 18-group hourly layout is refused, not misread', () => {
  assert.throws(() => parsePage(page('2024-12-13-old')), /groups/);
  assert.throws(() => parsePage(page('2024-06-17-next-fallback')), /groups/);
});

test('a cell whose tag and letter disagree fails the page', () => {
  const broken = page('2026-04-08').replace('<o>в</o>', '<o>з</o>');
  assert.throws(() => parsePage(broken), /<o>з<\/o>/);
  const short = page('2026-04-08').replace('<div id="inf3" data-id="3"><u>з</u>', '<div id="inf3" data-id="3">');
  assert.throws(() => parsePage(short), /47 cells/);
});

test('tomorrow comes from ?next only when it carries tomorrow\'s date', async () => {
  const now = new Date('2025-11-12T21:03:28Z');
  const run = (nextPage) => fetchRegion({ id: 'chernivtsi', title: 'Чернівецька область' }, now, {
    fetchPage: async (url) => (url.endsWith('?next') ? nextPage : page('2025-11-12')),
    wait: async () => {}
  });

  const both = await run(page('2025-11-13'));
  assert.deepEqual(Object.keys(both.fact.data).map(Number).sort(), [day('2025-11-12'), day('2025-11-13')]);
  assert.deepEqual(validate(both), []);

  // Without a published tomorrow, ?next serves today's table again: nothing more is published.
  const fallback = await run(page('2025-11-12'));
  assert.deepEqual(Object.keys(fallback.fact.data).map(Number), [day('2025-11-12')]);
});

test('out of season the region publishes its twelve groups and no day', async () => {
  const snapshot = await quiet(() => fetchRegion({ id: 'chernivtsi', title: 'Чернівецька область' },
    new Date('2026-10-01T15:03:57Z'), { fetchPage: async () => page('2026-10-01-offseason'), wait: async () => {} }));
  assert.deepEqual(snapshot.fact.data, []);
  assert.equal(Object.keys(snapshot.preset.sch_names).length, 12);
  assert.equal(snapshot.preset.sch_names.CV7, 'Група 7');
  assert.deepEqual(validate(snapshot), []);
});

const redate = (html, from, to) => html.split(from).join(to);
const allLight = (html) => html.replace(/<o>в<\/o>|<s>мз<\/s>/g, '<u>з</u>');

test('on the eve of the 23-hour day, at 23:30, tomorrow is still the next day', async () => {
  // 12/13.11.2025 moved to 27/28.03.2027, the night clocks go forward.
  const today = redate(redate(page('2025-11-12'), '13.11.2025', '28.03.2027'), '12.11.2025', '27.03.2027');
  const tomorrow = redate(page('2025-11-13'), '13.11.2025', '28.03.2027');
  const snapshot = await fetchRegion({ id: 'chernivtsi', title: 'Чернівецька область' }, new Date('2027-03-27T21:30:00Z'), {
    fetchPage: async (url) => (url.endsWith('?next') ? tomorrow : today),
    wait: async () => {}
  });
  assert.deepEqual(Object.keys(snapshot.fact.data).map(Number).sort(), [day('2027-03-27'), day('2027-03-28')]);
});

test('a failed ?next keeps today fresh and tomorrow as phones already have it', async () => {
  const now = new Date('2025-11-12T21:03:28Z');
  const published = await fetchRegion({ id: 'chernivtsi', title: 'Чернівецька область' }, now, {
    fetchPage: async (url) => (url.endsWith('?next') ? page('2025-11-13') : page('2025-11-12')),
    wait: async () => {}
  });
  const { value: snapshot } = await quietAsync(() => fetchRegion(
    { id: 'chernivtsi', title: 'Чернівецька область', previous: published }, now, {
      fetchPage: async (url) => { if (url.endsWith('?next')) throw new Error('HTTP 503'); return page('2025-11-12'); },
      wait: async () => {}
    }));
  assert.deepEqual(snapshot.fact.data, published.fact.data);

  // With no earlier copy, today alone.
  const { value: alone } = await quietAsync(() => fetchRegion({ id: 'chernivtsi', title: 'Чернівецька область' }, now, {
    fetchPage: async (url) => { if (url.endsWith('?next')) throw new Error('HTTP 503'); return page('2025-11-12'); },
    wait: async () => {}
  }));
  assert.deepEqual(Object.keys(alone.fact.data).map(Number), [day('2025-11-12')]);
});

test('a quiet, switched-off today still lets tomorrow\'s outages through', async () => {
  const quietToday = allLight(page('2025-11-12')).replace('<div id="gsv_t"', '<div id="gsv_24h"></div><div id="gsv_t"');
  const { value: snapshot } = await quietAsync(() => fetchRegion({ id: 'chernivtsi', title: 'Чернівецька область' },
    new Date('2025-11-12T21:03:28Z'), {
      fetchPage: async (url) => (url.endsWith('?next') ? page('2025-11-13') : quietToday),
      wait: async () => {}
    }));
  assert.deepEqual(Object.keys(snapshot.fact.data).map(Number), [day('2025-11-13')]);
});

async function quietAsync(fn) {
  const warn = console.warn;
  const seen = [];
  console.warn = (message) => seen.push(message);
  try { return { value: await fn(), seen }; } finally { console.warn = warn; }
}
