// format.js - small display helpers.

/** 65.3 -> "1:05", 3725 -> "1:02:05" */
export function formatTime(seconds) {
  const s = Math.max(0, Math.floor(Number(seconds) || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
}

/** 322029 -> "314 KB" */
export function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** Seconds between two ISO dates, or null. */
export function secondsBetween(fromIso, toIso) {
  const from = Date.parse(fromIso);
  const to = Date.parse(toIso);
  return Number.isFinite(from) && Number.isFinite(to) ? Math.max(0, Math.round((to - from) / 1000)) : null;
}

export const countWords = (text) => (text ? text.trim().split(/\s+/).filter(Boolean).length : 0);
