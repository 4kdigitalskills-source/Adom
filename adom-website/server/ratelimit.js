'use strict';
// In-memory sliding-window limiter. Fine for a single instance; use a shared store (Redis/Edge) if scaled out.
function createLimiter({ max, windowMs }) {
  const hits = new Map();
  const timer = setInterval(() => {
    const cutoff = Date.now() - windowMs;
    for (const [k, v] of hits) { const f = v.filter((t) => t > cutoff); f.length ? hits.set(k, f) : hits.delete(k); }
  }, Math.max(windowMs, 60000)); timer.unref();
  return {
    take(key) {
      const now = Date.now(), cutoff = now - windowMs;
      const arr = (hits.get(key) || []).filter((t) => t > cutoff);
      if (arr.length >= max) { hits.set(key, arr); return { allowed: false, retryAfterSec: Math.ceil((arr[0] + windowMs - now) / 1000) }; }
      arr.push(now); hits.set(key, arr); return { allowed: true };
    },
    reset(key) { hits.delete(key); }
  };
}
module.exports = { createLimiter };
