/**
 * Polite, retrying HTTP for the alias-source fetchers, and the folder a fetcher writes into.
 *
 * Every source of old street names (Rada acts, council tables, Wikipedia, Overpass) is a public
 * website run by somebody else, and several of them answer a perfectly good request with a 403, a
 * 502 or even a 200 that holds a challenge page instead of the document. So the rules live in one
 * place: one request at a time, a second or two between them, a descriptive User-Agent, back-off
 * (honouring Retry-After) on the statuses that mean "not now", and a per-file `validate` hook so a
 * 200 that is not the document counts as a failed attempt rather than a download.
 *
 * Downloads are untrusted data. They are written into a folder the caller names, which must be
 * outside every git checkout (never a data directory of this repo) and empty unless the run is a
 * resume of the same source, and nothing here ever executes or imports what it fetched.
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The repo this script lives in. Raw downloads must never end up under it. */
export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

export const UA_POLITE = 'Svitlo-aliases/1.0 (contact php701@gmail.com)';
/** Only for the hosts that refuse anything else (zakon.rada.gov.ua). */
export const UA_BROWSER =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Statuses that mean "try again later", not "this document does not exist". */
const RETRY_STATUS = new Set([403, 408, 425, 429, 500, 502, 503, 504, 520, 521, 522, 523, 524]);

export class FetchError extends Error {
  constructor(message, { url, status = null, attempts = 0, reason = '' } = {}) {
    super(message);
    this.name = 'FetchError';
    this.url = url;
    this.status = status;
    this.attempts = attempts;
    this.reason = reason;
  }
}

/** `Retry-After` is either a number of seconds or an HTTP date. Milliseconds, or null. */
export function retryAfterMs(value, now = Date.now()) {
  if (!value) return null;
  if (/^\d+$/.test(value.trim())) return Number(value) * 1000;
  const at = Date.parse(value);
  return Number.isNaN(at) ? null : Math.max(0, at - now);
}

/** Exponential back-off with ±25 % jitter: base, 2×base, 4×base … capped. */
export function backoffMs(attempt, { baseMs, maxMs, random = Math.random }) {
  const raw = Math.min(maxMs, baseMs * 2 ** (attempt - 1));
  return Math.round(raw * (0.75 + random() * 0.5));
}

/** Header block(s) of `curl -D` output → a Headers of the LAST response (redirects come first). */
export function parseCurlHeaders(text) {
  const blocks = text.split(/\r?\n\r?\n/).filter((b) => /^HTTP\//.test(b.trim()));
  const headers = new Headers();
  for (const line of (blocks.at(-1) ?? '').split(/\r?\n/).slice(1)) {
    const at = line.indexOf(':');
    if (at > 0) headers.append(line.slice(0, at).trim(), line.slice(at + 1).trim());
  }
  return headers;
}

/**
 * `fetch`, performed by the system `curl`. Some hosts answer Node's TLS handshake (zakon.rada.gov.ua
 * resets or times out every connection from undici while curl gets the page at once) and nothing in
 * a request header fixes that. Same call shape as `fetch` for what the fetchers use.
 */
export async function curlFetch(url, { method = 'GET', headers = {}, body, timeoutMs = 90000 } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'svitlo-curl-'));
  try {
    const bodyFile = join(dir, 'body');
    const headFile = join(dir, 'head');
    const args = [
      '-sS', '--compressed', '-L', '--max-redirs', '8',
      '--connect-timeout', '25', '--max-time', String(Math.ceil(timeoutMs / 1000)),
      '-o', bodyFile, '-D', headFile, '-w', '%{http_code}\n%{url_effective}'
    ];
    for (const [k, v] of Object.entries(headers)) args.push('-H', `${k}: ${v}`);
    if (method !== 'GET') args.push('-X', method);
    if (body != null) args.push('--data-binary', '@-');
    args.push('--', url);
    const out = await new Promise((resolveRun, reject) => {
      const proc = spawn('curl', args, { stdio: ['pipe', 'pipe', 'pipe'] });
      let stdout = '', stderr = '';
      proc.stdout.on('data', (d) => (stdout += d));
      proc.stderr.on('data', (d) => (stderr += d));
      proc.on('error', (err) => reject(Object.assign(new Error(`curl: ${err.message}`), { cause: { code: err.code } })));
      proc.on('close', (code) => {
        if (code === 0) return resolveRun(stdout);
        reject(Object.assign(new Error(`curl exit ${code}: ${stderr.trim()}`), { cause: { code: `CURL_${code}` } }));
      });
      proc.stdin.on('error', () => {});
      proc.stdin.end(body ?? undefined);
    });
    const [code, effective] = out.split('\n');
    const buf = await readFile(bodyFile);
    const head = await readFile(headFile, 'utf8').catch(() => '');
    return {
      status: Number(code),
      url: effective || url,
      headers: parseCurlHeaders(head),
      arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
    };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const defaultLog = (line) => process.stderr.write(`${line}\n`);

/**
 * A client that serialises its requests. Create one per source; do not share one across
 * concurrent callers (there is no queue, only a "last request ended at" clock).
 */
export function createClient({
  userAgent = UA_POLITE,
  minDelayMs = 1000,
  jitterMs = 1000,
  maxAttempts = 6,
  baseBackoffMs = 5000,
  maxBackoffMs = 120000,
  maxRetryAfterMs = 300000,
  timeoutMs = 90000,
  maxBytes = 64 * 1024 * 1024,
  log = defaultLog,
  // 'auto': Node's fetch, and curl for the rest of the run after the first connection-level failure;
  // 'curl' for hosts known to refuse Node's TLS; 'fetch' to never fall back. A function is used as is.
  transport = 'auto',
  sleepImpl = sleep,
  random = Math.random
} = {}) {
  let lastEnd = 0;
  let send = typeof transport === 'function' ? transport : transport === 'curl' ? curlFetch : globalThis.fetch;
  let canFallBack = transport === 'auto';

  const pace = async () => {
    const gap = minDelayMs + random() * jitterMs;
    const wait = lastEnd + gap - Date.now();
    if (lastEnd && wait > 0) await sleepImpl(wait);
  };

  /**
   * GET (or POST with `body`) one URL.
   *
   * `validate(buffer, response)` returns a problem string for a 200 that is not the document, or
   * a falsy value. A rejected 200 is retried like a 502: those sites hand out challenge pages and
   * truncated bodies with a success status.
   *
   * Resolves `{ status, url, body, headers, attempts }`; rejects with a FetchError, immediately
   * for a status that is not worth retrying (404, 410, 401 …).
   */
  async function request(url, opts = {}) {
    const {
      method = 'GET', headers = {}, body, validate,
      attempts: limit = maxAttempts, timeout = timeoutMs,
      userAgent: ua = userAgent, backoffBase = baseBackoffMs
    } = opts;
    let reason = 'no attempt made';
    let status = null;
    for (let attempt = 1; attempt <= limit; attempt++) {
      await pace();
      let res = null;
      let buf = null;
      let waitHint = null;
      try {
        res = await send(url, {
          method,
          body,
          redirect: 'follow',
          headers: { 'user-agent': ua, ...headers },
          signal: AbortSignal.timeout(timeout),
          timeoutMs: timeout
        });
        const declared = Number(res.headers.get('content-length') ?? 0);
        if (declared > maxBytes) throw new FetchError(`refusing ${declared} bytes`, { url, status: res.status });
        buf = Buffer.from(await res.arrayBuffer());
        if (buf.length > maxBytes) throw new FetchError(`refusing ${buf.length} bytes`, { url, status: res.status });
      } catch (err) {
        lastEnd = Date.now();
        if (err instanceof FetchError) throw err;
        status = null;
        reason = `network: ${err.cause?.code ?? err.name}: ${err.message}`;
        if (canFallBack) {
          // Node could not even complete the connection; curl may. Switch once and retry at once.
          canFallBack = false;
          send = curlFetch;
          log(`  ${reason}; switching to curl`);
          attempt--;
          continue;
        }
      }
      lastEnd = Date.now();

      if (res && buf) {
        status = res.status;
        if (status >= 200 && status < 300) {
          const problem = validate?.(buf, res);
          if (!problem) {
            return { status, url: res.url || url, body: buf, headers: res.headers, attempts: attempt };
          }
          reason = `HTTP ${status} but ${problem}`;
        } else if (RETRY_STATUS.has(status)) {
          reason = `HTTP ${status}`;
          waitHint = retryAfterMs(res.headers.get('retry-after'));
        } else {
          throw new FetchError(`${method} ${url}: HTTP ${status}`, { url, status, attempts: attempt, reason: `HTTP ${status}` });
        }
      }

      if (attempt === limit) break;
      const wait = Math.min(
        waitHint ?? backoffMs(attempt, { baseMs: backoffBase, maxMs: maxBackoffMs, random }),
        maxRetryAfterMs
      );
      log(`  retry ${attempt}/${limit - 1} in ${(wait / 1000).toFixed(0)}s: ${reason} (${url.slice(0, 110)})`);
      await sleepImpl(wait);
    }
    throw new FetchError(`${method} ${url}: gave up after ${limit} attempts (${reason})`, { url, status, attempts: limit, reason });
  }

  return { request, get: request };
}

/** A body as text, honouring a charset in the header or a `<meta>` (Ukrainian sites still send windows-1251). */
export function decodeBody(buf, contentType = '') {
  let charset = /charset=["']?([\w-]+)/i.exec(contentType)?.[1];
  if (!charset) {
    const head = buf.subarray(0, 4096).toString('latin1');
    charset = /<meta[^>]+charset=["']?([\w-]+)/i.exec(head)?.[1];
  }
  try {
    return new TextDecoder(charset || 'utf-8').decode(buf);
  } catch {
    return buf.toString('utf8');
  }
}

export const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

// --- the folder a fetcher writes into -------------------------------------------------------

/** True when `dir` or any parent of it holds a `.git` entry: raw dumps never go into a checkout. */
export async function insideGitCheckout(dir) {
  let at = resolve(dir);
  for (;;) {
    if (await stat(join(at, '.git')).catch(() => null)) return true;
    const up = dirname(at);
    if (up === at) return false;
    at = up;
  }
}

/** A relative path under the folder, with no way out of it. */
export function safeRelative(rel) {
  const clean = normalize(rel);
  if (isAbsolute(clean) || clean === '..' || clean.startsWith(`..${sep}`) || clean === '.') {
    throw new Error(`unsafe path ${rel}`);
  }
  return clean;
}

/**
 * Opens (creating) the folder one source is downloaded into.
 *
 * It must be new or empty, so one source's files can never be mixed with another's or with an
 * older run's; `resume: true` accepts a folder that holds a manifest of the SAME source and skips
 * the files it already has, which is how an interrupted Overpass or Rada run carries on.
 */
export async function openRawFolder(dir, { source, tool, userAgent = UA_POLITE, resume = false } = {}) {
  if (!dir) throw new Error('an output folder is required');
  const root = resolve(dir);
  if (await insideGitCheckout(root)) {
    throw new Error(`${root} is inside a git checkout; raw downloads go to a scratch folder outside the repo`);
  }
  const existing = await readdir(root).catch(() => null);
  const manifestPath = join(root, 'manifest.json');
  let manifest = null;
  if (existing && existing.length) {
    if (!resume) throw new Error(`${root} is not empty; use a new folder per source (or --resume to continue the same source)`);
    manifest = JSON.parse(await readFile(manifestPath, 'utf8').catch(() => 'null'));
    if (!manifest || manifest.source !== source) {
      throw new Error(`${root} has no manifest for source "${source}"; refusing to mix downloads`);
    }
  }
  await mkdir(root, { recursive: true });
  manifest ??= { source, tool, userAgent, startedAt: new Date().toISOString(), files: [], failures: [] };
  manifest.resumedAt = resume && existing?.length ? new Date().toISOString() : manifest.resumedAt;

  const flush = async () => {
    const tmp = `${manifestPath}.tmp`;
    await writeFile(tmp, `${JSON.stringify(manifest, null, 2)}\n`);
    await rename(tmp, manifestPath);
  };

  return {
    root,
    manifest,

    /** On resume: is this file already here, intact? */
    async has(rel) {
      const entry = manifest.files.find((f) => f.path === rel);
      if (!entry) return false;
      const buf = await readFile(join(root, rel)).catch(() => null);
      return !!buf && sha256(buf) === entry.sha256;
    },

    /** Writes the bytes exactly as received, then records them in the manifest. */
    async save(rel, buf, meta = {}) {
      const clean = safeRelative(rel);
      const target = join(root, clean);
      await mkdir(dirname(target), { recursive: true });
      const tmp = `${target}.part`;
      await writeFile(tmp, buf);
      await rename(tmp, target);
      const entry = {
        path: clean,
        bytes: buf.length,
        sha256: sha256(buf),
        fetchedAt: new Date().toISOString(),
        ...meta
      };
      manifest.files = manifest.files.filter((f) => f.path !== clean).concat(entry);
      manifest.failures = manifest.failures.filter((f) => f.path !== clean);
      await flush();
      return entry;
    },

    async fail(rel, url, error) {
      manifest.failures = manifest.failures.filter((f) => f.path !== rel).concat({ path: rel, url, error: String(error), at: new Date().toISOString() });
      await flush();
    },

    async finish(extra = {}) {
      manifest.finishedAt = new Date().toISOString();
      Object.assign(manifest, extra);
      await flush();
      return manifest;
    },

    async discard(rel) {
      await rm(join(root, safeRelative(rel)), { force: true });
    }
  };
}

/** Minimal flag parser shared by the fetchers: `--resume`, `--only=a,b`, `--key=value`, positionals. */
export function parseArgs(argv) {
  const flags = {};
  const positional = [];
  for (const arg of argv) {
    const m = /^--([\w-]+)(?:=(.*))?$/.exec(arg);
    if (m) flags[m[1]] = m[2] ?? true;
    else positional.push(arg);
  }
  return { flags, positional };
}

/** `file:///…/script.mjs` is the entry point of this process? Used to keep imports side-effect free. */
export function isMain(metaUrl) {
  return !!process.argv[1] && fileURLToPath(metaUrl) === resolve(process.argv[1]);
}

/** Prints the outcome of one fetcher run and returns the process exit code. */
export function reportRun(manifest) {
  const bytes = manifest.files.reduce((n, f) => n + f.bytes, 0);
  process.stderr.write(`${manifest.source}: ${manifest.files.length} file(s), ${bytes} bytes, ${manifest.failures.length} failure(s)\n`);
  for (const f of manifest.failures) process.stderr.write(`  FAILED ${f.path}: ${f.error}\n`);
  return manifest.failures.length ? 2 : 0;
}
