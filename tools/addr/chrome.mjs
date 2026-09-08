/**
 * A minimal Chrome DevTools Protocol client — enough to open a page and run script in it.
 *
 * ДТЕК sits behind an Imperva Incapsula WAF: a plain `fetch` gets a 212-byte JS challenge, and no
 * combination of headers gets past it, so the address lookup genuinely needs a real browser. Rather
 * than pull in Playwright (this repo has no dependencies at all, and the mirror deliberately avoids
 * running its own headless fleet — see sources/dtek.mjs), we drive the Chrome that is already
 * installed over CDP. Node 22+ ships a global WebSocket, so this needs nothing from npm.
 *
 * This is NOT used by the 10-minute mirror. Address→черга mapping changes about as often as the
 * grid is re-segmented, so it is a manual/monthly job whose output is committed.
 */
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = 9333;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Chrome needs a moment before the debugging port answers; poll rather than guess a delay. */
async function waitForPort(timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/version`);
      if (r.ok) return await r.json();
    } catch {}
    await sleep(250);
  }
  throw new Error(`Chrome did not open the debugging port within ${timeoutMs}ms`);
}

export async function launch({ headless = true } = {}) {
  const profile = await mkdtemp(join(tmpdir(), 'svitlo-addr-'));
  const args = [
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-networking',
    // Incapsula fingerprints the automation flag, so the "new" headless mode is the one to use.
    ...(headless ? ['--headless=new'] : []),
    'about:blank'
  ];
  const proc = spawn(CHROME, args, { stdio: 'ignore', detached: false });
  await waitForPort();

  return {
    async open(url) {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/new?${encodeURIComponent(url)}`, { method: 'PUT' });
      if (!r.ok) throw new Error(`could not open tab: ${r.status}`);
      const target = await r.json();
      return connect(target);
    },
    async close() {
      try { proc.kill(); } catch {}
      await rm(profile, { recursive: true, force: true }).catch(() => {});
    }
  };
}

function connect(target) {
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  let nextId = 1;
  const pending = new Map();

  const ready = new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', () => reject(new Error('CDP socket failed')), { once: true });
  });

  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(ev.data);
    const slot = pending.get(msg.id);
    if (!slot) return;
    pending.delete(msg.id);
    if (msg.error) slot.reject(new Error(msg.error.message));
    else slot.resolve(msg.result);
  });

  const send = async (method, params = {}) => {
    await ready;
    const id = nextId++;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params }));
    });
  };

  return {
    /**
     * Run an async expression in the page and return its value.
     * `timeoutMs` guards against a hung request inside the page: CDP itself would wait forever.
     */
    async evaluate(expression, { timeoutMs = 120000 } = {}) {
      const call = send('Runtime.evaluate', {
        expression: `(async () => { ${expression} })()`,
        awaitPromise: true,
        returnByValue: true
      });
      const timer = new Promise((_, rej) => setTimeout(() => rej(new Error('page script timed out')), timeoutMs));
      const res = await Promise.race([call, timer]);
      if (res.exceptionDetails) {
        throw new Error(res.exceptionDetails.exception?.description || 'page script threw');
      }
      return res.result.value;
    },
    /** The WAF challenge resolves via script, so wait for the real document rather than load events. */
    async waitForSelector(selector, timeoutMs = 30000) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const found = await this.evaluate(`return !!document.querySelector(${JSON.stringify(selector)});`);
        if (found) return true;
        await sleep(400);
      }
      throw new Error(`selector ${selector} never appeared`);
    },
    close: () => ws.close()
  };
}
