// HTTP headers are Latin-1 only, so the app's Ukrainian name stays out of the UA string.
const USER_AGENT = 'svitlo-mirror/1.0 (+https://koly-svitlo.web.app; outage schedule mirror)';

/** Identifies itself honestly and retries only on transport errors, never on a 4xx. */
export async function getJSON(url, { retries = 2, timeoutMs = 20000 } = {}) {
  return get(url, { retries, timeoutMs }).then((response) => response.json());
}

export async function getText(url, options = {}) {
  return get(url, options).then((response) => response.text());
}

/**
 * A form POST, for the operators whose own page asks that way (Полтава's `newgpv-info.php`). The
 * same retry rules as a GET: a POST that only reads is as safe to repeat as one.
 */
export async function postForm(url, fields, options = {}) {
  return get(url, {
    ...options,
    method: 'POST',
    body: new URLSearchParams(fields).toString(),
    headers: { 'content-type': 'application/x-www-form-urlencoded; charset=UTF-8', ...options.headers }
  }).then((response) => response.text());
}

async function get(url, { retries = 2, timeoutMs = 20000, headers = {}, method = 'GET', body } = {}) {
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, {
        method,
        body,
        signal: controller.signal,
        headers: { 'user-agent': USER_AGENT, 'accept-language': 'uk-UA,uk;q=0.9', ...headers }
      });
      if (!response.ok) {
        const error = new Error(`HTTP ${response.status}`);
        // A 4xx is the server's answer, not a lost packet: asking again a second later only repeats
        // a refusal — a 429 or 403 above all — to a server that has just asked us to back off.
        error.retry = response.status >= 500;
        throw error;
      }
      return response;
    } catch (error) {
      lastError = error;
      if (error.retry === false) break;
      // Backing off matters: these are small operators' servers, often during a blackout.
      if (attempt < retries) await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError;
}
