// HTTP headers are Latin-1 only, so the app's Ukrainian name stays out of the UA string.
const USER_AGENT = 'svitlo-mirror/1.0 (+https://koly-svitlo.web.app; outage schedule mirror)';

/** Identifies itself honestly and retries only on transport errors, never on a 4xx. */
export async function getJSON(url, { retries = 2, timeoutMs = 20000 } = {}) {
  return get(url, { retries, timeoutMs }).then((response) => response.json());
}

export async function getText(url, options = {}) {
  return get(url, options).then((response) => response.text());
}

async function get(url, { retries = 2, timeoutMs = 20000, headers = {} } = {}) {
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, {
        signal: controller.signal,
        headers: { 'user-agent': USER_AGENT, 'accept-language': 'uk-UA,uk;q=0.9', ...headers }
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return response;
    } catch (error) {
      lastError = error;
      // Backing off matters: these are small operators' servers, often during a blackout.
      if (attempt < retries) await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError;
}
