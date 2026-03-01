const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504]);

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function shouldRetry(error, attempt, maxAttempts) {
  if (attempt >= maxAttempts - 1) {
    return false;
  }

  if (error && typeof error.statusCode === 'number') {
    return RETRYABLE_STATUS.has(error.statusCode);
  }

  if (error && error.name === 'AbortError') {
    return true;
  }

  return true;
}

async function fetchJsonWithRetry(url, options = {}) {
  const timeoutMs = options.timeoutMs || 10000;
  const maxAttempts = options.maxAttempts || 3;
  const retryDelayMs = options.retryDelayMs || 400;
  const method = options.method || 'GET';
  const headers = options.headers || undefined;
  const body = options.body || undefined;

  let lastError = null;

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(url, {
        signal: controller.signal,
        method,
        headers,
        body
      });

      if (!response.ok) {
        const error = new Error(`HTTP ${response.status} ${response.statusText}`);
        error.statusCode = response.status;
        throw error;
      }

      return await response.json();
    } catch (error) {
      lastError = error;

      if (!shouldRetry(error, attempt, maxAttempts)) {
        throw error;
      }

      const delay = retryDelayMs * (attempt + 1);
      await wait(delay);
    } finally {
      clearTimeout(timeout);
    }
  }

  throw lastError || new Error('Upstream request failed');
}

module.exports = {
  fetchJsonWithRetry
};
