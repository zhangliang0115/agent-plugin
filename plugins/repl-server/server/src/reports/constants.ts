/** Every tunable number for reports and alerts lives here (design 06 §3.4, §4). @module */

/** Duplicate-fingerprint window for MCP reports. */
export const DEDUPE_WINDOW_MS = 10 * 60 * 1000;

/** Per-owner MCP report budget. */
export const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000;
export const RATE_LIMIT_MAX = 20;

export const MAX_TITLE_CODE_POINTS = 200;
export const MAX_DETAIL_CODE_POINTS = 20_000;
export const MAX_CONTEXT_BYTES = 8192;
export const MAX_RESOLUTION_CODE_POINTS = 4000;

/** Per-attempt webhook timeout. */
export const ALERT_SEND_TIMEOUT_MS = 5_000;
/** One retry, 500 ms apart. */
export const ALERT_RETRY_DELAY_MS = 500;
export const ALERT_MAX_ATTEMPTS = 2;

/** WeCom allows 20 messages/minute; serial sends keep at least this gap. */
export const MIN_SEND_INTERVAL_MS = 3_000;
/** 45009 cooldown before a pending row is claimed again. */
export const WECOM_RATE_LIMIT_BACKOFF_MS = 60_000;

export const ALERT_TICK_MS = 30_000;
/** Rows stuck in `sending` longer than this are returned to `pending` by the tick. */
export const ALERT_STALE_SENDING_MS = 60_000;
/** Pending rows older than this fail at startup. */
export const ALERT_STALE_PENDING_MS = 24 * 60 * 60 * 1000;

export const ALERT_CLAIM_LIMIT = 20;
export const ALERT_TEST_THROTTLE_MS = 5_000;
export const ALERT_TEST_TIMEOUT_MS = 10_500;

export const MAX_ALERT_ERROR_CHARS = 500;
export const MAX_ALERT_ERROR_MESSAGE_CHARS = 200;
export const WECOM_MARKDOWN_MAX_BYTES = 4096;

export const REPORT_ID_PREFIX = 'rep';
export const REPORT_ID_PATTERN = /^rep_[0-9a-f]{32}$/;
