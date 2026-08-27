#!/usr/bin/env node
/**
 * Sends the "region changed" nudge — after the deploy, never before.
 *
 * Split out of `mirror.mjs` deliberately. The mirror knows *which* regions moved, but it runs
 * before the files are published; a phone woken at that moment refetches the old schedule and
 * goes back to sleep believing it is current. So the mirror records the list and this runs once
 * Firebase Hosting is actually serving the new data.
 *
 * Usage: node tools/mirror/send-push.mjs kyiv,odesa
 */
import { notifyRegion } from './lib/notify.mjs';

// `--visible "Title|Body"` makes the push show a banner. Delivery to a device cannot otherwise
// be confirmed without reading its log, which needs root. Never used by the cron.
const args = process.argv.slice(2);
const visibleIndex = args.indexOf('--visible');
let visible;
if (visibleIndex !== -1) {
  const [title, body] = (args[visibleIndex + 1] ?? '').split('|');
  visible = { title: title ?? 'Тест', body: body ?? '' };
  args.splice(visibleIndex, 2);
}

const regions = (args[0] ?? '').split(',').map((s) => s.trim()).filter(Boolean);
if (regions.length === 0) {
  console.log('[push] nothing to announce');
  process.exit(0);
}

let failed = 0;
for (const region of regions) {
  try {
    await notifyRegion(region, {
      credentialsPath: process.env.GOOGLE_APPLICATION_CREDENTIALS,
      dryRun: process.env.PUSH_DRY_RUN === '1',
      visible
    });
  } catch (error) {
    // A push that does not go out costs freshness, not correctness — the app still refetches on
    // launch and on background refresh. Report it, but never fail the run over it.
    console.error(`[push] ${region}: ${error.message}`);
    failed++;
  }
}
console.log(`[push] ${regions.length - failed}/${regions.length} sent`);
