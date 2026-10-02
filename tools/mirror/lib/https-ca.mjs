import { request } from 'node:https';
import { rootCertificates } from 'node:tls';
import { USER_AGENT } from './http.mjs';

/**
 * A GET for a server that sends its certificate without the intermediate that signed it — which
 * browsers paper over and Node does not (UNABLE_TO_VERIFY_LEAF_SIGNATURE). The missing
 * intermediate is supplied for this one request, next to the usual roots, so the chain is still
 * checked all the way up; nothing else in the process trusts anything new, and verification is
 * never switched off.
 *
 * `fetch` cannot take a CA list, hence `node:https`. Same rules as lib/http.mjs: an honest user
 * agent, a timeout that covers the body, retries only for transport errors and 5xx.
 */
export async function getTextTrusting(url, { intermediate, timeoutMs = 20000, retries = 1, maxBytes = 3_000_000 } = {}) {
  const ca = [...rootCertificates, intermediate];
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      // A redirect within the same site (a renamed page, a trailing slash) is followed, twice at
      // most; one to another host is refused, since the CA was supplied for this one.
      let target = new URL(url);
      for (let hop = 0; ; hop++) {
        const answer = await once(target.href, ca, timeoutMs, maxBytes);
        if (answer.location === undefined) return answer.body;
        const next = new URL(answer.location, target);
        if (hop >= 2 || next.host !== target.host || next.protocol !== 'https:') {
          const error = new Error(`redirected to ${next.href}`);
          error.retry = false;
          throw error;
        }
        target = next;
      }
    } catch (error) {
      lastError = error;
      if (error.retry === false) break;
      if (attempt < retries) await new Promise((resolve) => setTimeout(resolve, 1000 * (attempt + 1)));
    }
  }
  throw lastError;
}

function once(url, ca, timeoutMs, maxBytes) {
  return new Promise((resolveOnce, rejectOnce) => {
    // A deadline for the whole exchange, body included — a socket idle timeout would let a
    // trickling body run on.
    const timer = setTimeout(() => req.destroy(new Error(`no answer in ${timeoutMs / 1000} s`)), timeoutMs);
    const resolve = (value) => { clearTimeout(timer); resolveOnce(value); };
    const reject = (error) => { clearTimeout(timer); rejectOnce(error); };
    const req = request(url, {
      ca,
      headers: { 'user-agent': USER_AGENT, 'accept-language': 'uk-UA,uk;q=0.9' }
    }, (response) => {
      if ([301, 302, 303, 307, 308].includes(response.statusCode) && response.headers.location) {
        response.resume();
        resolve({ location: response.headers.location });
        return;
      }
      if (response.statusCode !== 200) {
        response.resume();
        const error = new Error(`HTTP ${response.statusCode}`);
        error.retry = response.statusCode >= 500;
        reject(error);
        return;
      }
      const chunks = [];
      let size = 0;
      response.on('data', (chunk) => {
        size += chunk.length;
        if (size > maxBytes) req.destroy(new Error(`more than ${maxBytes} bytes`));
        else chunks.push(chunk);
      });
      response.on('end', () => resolve({ body: Buffer.concat(chunks).toString('utf8') }));
      response.on('error', reject);
    });
    req.on('error', reject);
    req.end();
  });
}
