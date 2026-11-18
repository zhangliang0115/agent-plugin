/** Limits shared by the AI runner, validators and stores (08 §2–§4). @module */

/** UTF-8 byte ceiling for the one-line prompt input; not a character count. */
export const AI_INPUT_MAX_BYTES = 16 * 1024;

/** stdout ceiling; exceeding it kills the process group immediately. */
export const AI_OUTPUT_MAX_BYTES = 256 * 1024;

/** How much stderr is kept; the rest is read and discarded so the pipe never blocks. */
export const AI_STDERR_MAX_BYTES = 8 * 1024;

export const AI_DEFAULT_TIMEOUT_MS = 60_000;
export const AI_TIMEOUT_MIN_MS = 5_000;
export const AI_TIMEOUT_MAX_MS = 180_000;

export const AI_MAX_TOOLS = 80;
export const AI_TOOL_DESCRIPTION_MAX = 400;
export const AI_PROMPT_MAX_BYTES = 64 * 1024;

export const AI_PROPOSAL_TTL_MS = 10 * 60_000;
export const AI_PROPOSAL_MAX = 50;
export const AI_ANNOTATION_TTL_MS = 30 * 60_000;
export const AI_ANNOTATION_MAX = 20;
export const AI_AUTO_MIN_INTERVAL_MS = 60_000;

export const AI_LIMITER_RUNNING = 2;
export const AI_LIMITER_QUEUED = 4;
export const AI_LIMITER_WAIT_MS = 30_000;

/**
 * Fixed argv prefix for every run. Adding a flag is a design change (08 §2.2), not
 * a local tweak: `--safe-mode` skips hooks/CLAUDE.md, `--strict-mcp-config` plus an
 * explicit empty `--mcp-config` keeps user MCP servers out, and `--tools ""`
 * disables built-in tools only.
 */
export const AI_FIXED_ARGS = [
  '-p',
  '--output-format',
  'json',
  '--tools',
  '',
  '--strict-mcp-config',
  '--safe-mode',
  '--no-session-persistence',
  '--max-turns',
  '1',
] as const;

/**
 * Environment variables forwarded to `claude`. Anthropic variables may contain
 * credentials and are passed only to the trusted CLI; they never reach logs,
 * audit events or responses.
 */
export const AI_ENV_KEYS = [
  'PATH',
  'HOME',
  'LANG',
  'LC_ALL',
  'TMPDIR',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
] as const;

export const AI_MCP_CONFIG_JSON = '{"mcpServers":{}}';
