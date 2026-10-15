// Badges.jsx - small colored labels for HTTP methods and status codes.

const STATUS_TEXT = {
  0: 'No connection',
  200: 'OK',
  201: 'Created',
  202: 'Accepted',
  204: 'No Content',
  400: 'Bad Request',
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'Not Found',
  405: 'Method Not Allowed',
  409: 'Conflict',
  413: 'Too Large',
  415: 'Unsupported Type',
  422: 'Validation Error',
  429: 'Too Many Requests',
  500: 'Server Error',
  502: 'Bad Gateway',
  503: 'Unavailable',
};

export function MethodBadge({ method }) {
  return <span className={`method method-${method.toLowerCase()}`}>{method}</span>;
}

/** 2xx green, 4xx amber, 5xx / no connection red. */
export function StatusBadge({ status, compact = false }) {
  const kind = status >= 200 && status < 300 ? 'ok' : status >= 400 && status < 500 ? 'warn' : 'err';
  return (
    <span className={`status-badge is-${kind}`}>
      {status || '—'}
      {!compact && STATUS_TEXT[status] ? ` ${STATUS_TEXT[status]}` : ''}
    </span>
  );
}
