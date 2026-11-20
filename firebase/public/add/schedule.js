// The schedule of one queue for a browser: what the page behind «Поділитися» shows to somebody without the app
// (an Android phone, a computer). Plain old JavaScript, no build step: phones that open these links are not new.
//
// It reads the same files the app reads (/v1/<region>.json) and says only what the operator published:
// a day that is not in `fact.data` is «не оприлюднено», never a guess from the weekly template.
// tools/mirror/web-schedule.test.mjs runs this file as it is.
(function (root) {
  'use strict';

  var KYIV = ['Europe/Kyiv', 'Europe/Kiev'];   // browsers older than the 2022 rename know only the second

  function pad(n) { return (n < 10 ? '0' : '') + n; }

  // The last Sunday of a month, as a day number, in UTC.
  function lastSunday(year, month) {
    var last = new Date(Date.UTC(year, month + 1, 0));
    return last.getUTCDate() - last.getUTCDay();
  }

  // Ukraine keeps the European rule: summer time from 01:00 UTC on the last Sunday of March to 01:00 UTC on the
  // last Sunday of October. Only for a browser whose Intl cannot name the zone.
  function kyivOffsetByRule(ms) {
    var year = new Date(ms).getUTCFullYear();
    var from = Date.UTC(year, 2, lastSunday(year, 2), 1);
    var to = Date.UTC(year, 9, lastSunday(year, 9), 1);
    return ms >= from && ms < to ? 3 : 2;
  }

  function partsByIntl(ms, zone) {
    var parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: zone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit'
    }).formatToParts(new Date(ms));
    var got = {};
    for (var i = 0; i < parts.length; i++) got[parts[i].type] = parts[i].value;
    var hour = Number(got.hour) % 24;   // some engines say «24» at midnight whatever the cycle
    if (!(Number(got.year) > 2000) || isNaN(hour)) throw new Error('no parts');
    return { year: Number(got.year), month: Number(got.month), day: Number(got.day), hour: hour, minute: Number(got.minute) };
  }

  /** The Kyiv wall clock at an instant: { year, month, day, hour, minute, key: 'YYYY-MM-DD' }. */
  function kyivParts(ms, intl) {
    var parts = null;
    if (intl !== false) {
      for (var i = 0; i < KYIV.length && !parts; i++) {
        try { parts = partsByIntl(ms, KYIV[i]); } catch (e) { parts = null; }
      }
    }
    if (!parts) {
      var shifted = new Date(ms + kyivOffsetByRule(ms) * 3600000);
      parts = { year: shifted.getUTCFullYear(), month: shifted.getUTCMonth() + 1, day: shifted.getUTCDate(),
                hour: shifted.getUTCHours(), minute: shifted.getUTCMinutes() };
    }
    parts.key = parts.year + '-' + pad(parts.month) + '-' + pad(parts.day);
    return parts;
  }

  /** The date after `key` ('YYYY-MM-DD'), as a key. */
  function nextKey(key) {
    var p = key.split('-');
    var d = new Date(Date.UTC(Number(p[0]), Number(p[1]) - 1, Number(p[2]) + 1));
    return d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1) + '-' + pad(d.getUTCDate());
  }

  /** `fact.data` is an object keyed by the day's Kyiv midnight — and an empty ARRAY out of season. */
  function days(fact) {
    var data = fact && fact.data;
    return data && typeof data === 'object' && !Array.isArray(data) ? data : {};
  }

  /** The key of `fact.data` whose Kyiv date is `dateKey`, or null: the day is told by its date, not by arithmetic. */
  function dayEpoch(fact, dateKey, intl) {
    var keys = Object.keys(days(fact));
    for (var i = 0; i < keys.length; i++) {
      var epoch = Number(keys[i]);
      // an hour past the key, so a key written a little off midnight still falls on its day
      if (epoch > 0 && kyivParts(epoch * 1000 + 3600000, intl).key === dateKey) return keys[i];
    }
    return null;
  }

  // ДТЕК's states name an hour; «first» and «second» name its halves. Anything unknown is said to be unknown,
  // never «світло є».
  var HALVES = {
    yes: ['on', 'on'], no: ['off', 'off'], first: ['off', 'on'], second: ['on', 'off'],
    maybe: ['maybe', 'maybe'], mfirst: ['maybe', 'on'], msecond: ['on', 'maybe']
  };

  /** The queue's day as 48 half hours of 'on' | 'off' | 'maybe' | 'unknown', or null when the day or the queue is not there. */
  function slots(fact, epochKey, queue) {
    var day = epochKey === null ? null : days(fact)[epochKey];
    var row = day && day[queue];
    if (!row || typeof row !== 'object') return null;
    var out = [];
    for (var hour = 1; hour <= 24; hour++) {
      var halves = HALVES[row[hour]] || ['unknown', 'unknown'];
      out.push(halves[0], halves[1]);
    }
    return out;
  }

  /** «10:30» for a half-hour index; 48 is «24:00», and past it the clock of the next day. */
  function clock(slot) {
    if (slot === 48) return '24:00';
    var s = slot % 48;
    return pad(Math.floor(s / 2)) + ':' + (s % 2 ? '30' : '00');
  }

  /** The stretches of `state` in a day: [{ from, to }] in half-hour indices, `to` exclusive. */
  function intervals(daySlots, state) {
    var out = [];
    var from = -1;
    for (var i = 0; i <= daySlots.length; i++) {
      var on = i < daySlots.length && daySlots[i] === state;
      if (on && from < 0) from = i;
      if (!on && from >= 0) { out.push({ from: from, to: i }); from = -1; }
    }
    return out;
  }

  function minutes(daySlots, state) {
    var n = 0;
    for (var i = 0; i < daySlots.length; i++) if (daySlots[i] === state) n++;
    return n * 30;
  }

  /**
   * What the schedule says of this half hour and when that changes: { state, until } with `until` a half-hour index
   * counted from today's midnight (above 48 it is tomorrow), or null when the published days end before any change.
   */
  function status(today, tomorrow, nowSlot) {
    if (!today || nowSlot < 0 || nowSlot >= today.length) return null;
    var state = today[nowSlot];
    var all = tomorrow ? today.concat(tomorrow) : today;
    for (var i = nowSlot + 1; i < all.length; i++) {
      if (all[i] !== state) return { state: state, until: i };
    }
    return { state: state, until: null };
  }

  /**
   * Whether an order beyond the schedule stands for the queue on a day. A queue with an operator of its own inside
   * the region (ЦЕК under «Дніпро») listens to that operator's order and to no other.
   */
  function emergency(fact, queue, epochKey) {
    if (!fact || epochKey === null) return { on: false, note: null };
    var day = Number(epochKey);
    var own = fact.queueEmergency;
    var has = function (list) {
      if (!Array.isArray(list)) return false;
      for (var i = 0; i < list.length; i++) if (Number(list[i]) === day) return true;
      return false;
    };
    if (own && Array.isArray(own.queues) && own.queues.indexOf(queue) >= 0) {
      return has(own.days) ? { on: true, note: own.note || null } : { on: false, note: null };
    }
    return has(fact.emergency) ? { on: true, note: fact.emergencyNote || null } : { on: false, note: null };
  }

  /** «GPV10.1» after «GPV2.1»: by the numbers in the key, not by its letters. */
  function compareQueues(a, b) {
    var x = (a.match(/\d+/g) || []).map(Number);
    var y = (b.match(/\d+/g) || []).map(Number);
    for (var i = 0; i < Math.max(x.length, y.length); i++) {
      var d = (x[i] === undefined ? -1 : x[i]) - (y[i] === undefined ? -1 : y[i]);
      if (d) return d;
    }
    return a < b ? -1 : a > b ? 1 : 0;
  }

  /** The queues a region file can show, in order: [{ id, name }]. Names are the operator's («Черга 3.1», «ЦЕК 5.2»). */
  function queues(data) {
    var names = (data && data.preset && data.preset.sch_names) || {};
    var seen = {};
    var ids = [];
    var add = function (id) { if (!seen[id]) { seen[id] = true; ids.push(id); } };
    Object.keys(names).forEach(add);
    var published = days(data && data.fact);
    Object.keys(published).forEach(function (key) { Object.keys(published[key] || {}).forEach(add); });
    return ids.sort(compareQueues).map(function (id) { return { id: id, name: names[id] || id.replace(/^GPV/, 'Черга ') }; });
  }

  /**
   * Everything the page says for a queue at an instant, with no words in it: the page puts them in the reader's language.
   */
  function view(data, queue, nowMs, intl) {
    var fact = (data && data.fact) || {};
    var now = kyivParts(nowMs, intl);
    var todayKey = dayEpoch(fact, now.key, intl);
    var tomorrowDate = nextKey(now.key);
    var tomorrowKey = dayEpoch(fact, tomorrowDate, intl);
    var today = slots(fact, todayKey, queue);
    var tomorrow = slots(fact, tomorrowKey, queue);
    var nowSlot = now.hour * 2 + (now.minute >= 30 ? 1 : 0);
    var describe = function (date, key, daySlots) {
      return {
        date: date,
        published: !!daySlots,
        slots: daySlots,
        off: daySlots ? intervals(daySlots, 'off') : [],
        maybe: daySlots ? intervals(daySlots, 'maybe') : [],
        offMinutes: daySlots ? minutes(daySlots, 'off') : 0,
        unknown: daySlots ? minutes(daySlots, 'unknown') > 0 : false,
        emergency: emergency(fact, queue, key)
      };
    };
    return {
      now: now,
      nowSlot: nowSlot,
      status: status(today, tomorrow, nowSlot),
      today: describe(now.key, todayKey, today),
      tomorrow: describe(tomorrowDate, tomorrowKey, tomorrow),
      update: typeof fact.update === 'string' && fact.update ? fact.update : null
    };
  }

  root.KolySvitloSchedule = {
    kyivParts: kyivParts, nextKey: nextKey, dayEpoch: dayEpoch, slots: slots, clock: clock, intervals: intervals,
    minutes: minutes, status: status, emergency: emergency, compareQueues: compareQueues, queues: queues, view: view
  };
}(typeof window !== 'undefined' ? window : this));
