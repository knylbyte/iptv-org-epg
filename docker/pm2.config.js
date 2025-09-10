// docker/pm2.config.js
// Distroless-ready PM2 config (no npm/npx at runtime) with list support in SITE and CLANG.
//
// Expected environment variables (e.g., via Docker ENV):
//   CRON_SCHEDULE="0 2 * * *"
//   PORT=3000
//   MAX_CONNECTIONS=1
//   GZIP=0|1
//   CURL=0|1
//   RUN_AT_STARTUP=0|1
//   TIMEOUT=<ms>
//   DELAY=<ms>
//   DAYS=<int>
//   PROXY=http://user:pass@host:port
//
// Accepted formats for SITE and CLANG:
//   - Multiline scalar (recommended in compose):
//       SITE: |
//         example.com
//         epg.io
//       CLANG: |
//         en
//         es
//   - Comma/space/semicolon/newline separated: "example.com, example.io"
//   - JSON array string: '["example.com","example.io"]'
//
// Notes:
// - No shell in distroless. Everything runs via /nodejs/bin/node.
// - If SITE or CLANG is empty, we fall back to /epg/channels.xml (must be bind-mounted).

const NODE       = '/nodejs/bin/node';
const SERVE_JS   = 'node_modules/serve/bin/serve.js';
const CHRONOS_JS = 'node_modules/chronos-cli/bin/chronos.js';
const TSX_JS     = 'node_modules/tsx/dist/cli.js';

const envBool = (v, def = false) => {
  if (v === undefined) return def;
  const s = String(v).trim().toLowerCase();
  return !['', '0', 'false', 'no', 'off', 'null', 'undefined'].includes(s);
};

const envInt = (v) => {
  if (v === undefined || String(v).trim() === '') return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
};

// Parse a single env var (SITE or CLANG) into a list
const parseListFromSingleKey = (key) => {
  const raw = process.env[key];
  if (raw === undefined) return [];
  const s = String(raw).trim();
  if (!s) return [];

  // JSON array support
  if (s[0] === '[') {
    try {
      const arr = JSON.parse(s);
      if (Array.isArray(arr)) {
        return arr
          .map((x) => String(x).trim())
          .filter((x) => x.length > 0);
      }
    } catch {
      // fall back to delimiter parsing below
    }
  }

  // Delimiters: newline, comma, semicolon, whitespace
  return s
    .split(/[\n\r,;\s]+/g)
    .map((x) => x.trim())
    .filter((x) => x.length > 0);
};

const slug = (t) => String(t).toLowerCase().replace(/[^a-z0-9._-]+/g, '-').slice(0, 80);

// ---- read env ----
const CRON_SCHEDULE   = process.env.CRON_SCHEDULE || '0 0 * * *';
const PORT            = envInt(process.env.PORT) || 3000;
const MAX_CONNECTIONS = envInt(process.env.MAX_CONNECTIONS) ?? 1;
const GZIP            = envBool(process.env.GZIP, false);
const CURL            = envBool(process.env.CURL, false);
const RUN_AT_STARTUP  = envBool(process.env.RUN_AT_STARTUP, true);
const TIMEOUT         = envInt(process.env.TIMEOUT);
const DELAY           = envInt(process.env.DELAY);
const DAYS            = envInt(process.env.DAYS);
const PROXY           = process.env.PROXY;

// Site(s) and lang(s) — same variable names, but accept lists
const SITE_LIST  = parseListFromSingleKey('SITE');
const CLANG_LIST = parseListFromSingleKey('CLANG');
const LANG_CSV   = CLANG_LIST.length ? CLANG_LIST.join(',') : undefined;

// Build grab args from config
const buildGrabArgs = ({ site, useChannelsXml }) => {
  const args = [];
  if (site && !useChannelsXml) {
    args.push('--site', site);
  } else {
    args.push('--channels', 'channels.xml');
  }
  args.push('--output', 'public/guide.xml');
  args.push('--maxConnections', String(MAX_CONNECTIONS));
  if (DAYS    !== undefined) args.push('--days', String(DAYS));
  if (TIMEOUT !== undefined) args.push('--timeout', String(TIMEOUT));
  if (DELAY   !== undefined) args.push('--delay', String(DELAY));
  if (PROXY)                  args.push('--proxy', PROXY);
  if (LANG_CSV)               args.push('--lang', LANG_CSV);
  if (GZIP)                   args.push('--gzip');
  if (CURL)                   args.push('--curl');
  return args;
};

const makeGrabExec = (grabArgs) =>
  [NODE, TSX_JS, 'scripts/commands/epg/grab.ts', ...grabArgs].join(' ');

// ---- PM2 apps ----
const apps = [
  {
    name: 'serve',
    cwd: '/epg',
    script: NODE,
    args: [SERVE_JS, '-l', `tcp://0.0.0.0:${PORT}`, 'public'],
    interpreter: 'none',
    autorestart: true,
    watch: false
  }
];

if (SITE_LIST.length > 0) {
  // Multi-site mode: one scheduled grab (and optional one-shot) per site
  for (const site of SITE_LIST) {
    const id = slug(site);
    const grabArgs = buildGrabArgs({ site, useChannelsXml: false });
    const grabExec = makeGrabExec(grabArgs);

    apps.push({
      name: `grab:${id}`,
      cwd: '/epg',
      script: NODE,
      args: [CHRONOS_JS, '--execute', grabExec, '--pattern', CRON_SCHEDULE, '--log'],
      interpreter: 'none',
      autorestart: true,
      exp_backoff_restart_delay: 5000,
      watch: false
    });

    if (RUN_AT_STARTUP) {
      apps.push({
        name: `grab-at-startup:${id}`,
        cwd: '/epg',
        script: NODE,
        args: [TSX_JS, 'scripts/commands/epg/grab.ts', ...grabArgs],
        interpreter: 'none',
        autorestart: false,
        stop_exit_codes: [0],
        watch: false
      });
    }
  }
} else {
  // channels.xml fallback
  const grabArgs = buildGrabArgs({ site: undefined, useChannelsXml: true });
  const grabExec = makeGrabExec(grabArgs);

  apps.push({
    name: 'grab',
    cwd: '/epg',
    script: NODE,
    args: [CHRONOS_JS, '--execute', grabExec, '--pattern', CRON_SCHEDULE, '--log'],
    interpreter: 'none',
    autorestart: true,
    exp_backoff_restart_delay: 5000,
    watch: false
  });

  if (RUN_AT_STARTUP) {
    apps.push({
      name: 'grab-at-startup',
      cwd: '/epg',
      script: NODE,
      args: [TSX_JS, 'scripts/commands/epg/grab.ts', ...grabArgs],
      interpreter: 'none',
      autorestart: false,
      stop_exit_codes: [0],
      watch: false
    });
  }
}

module.exports = { apps };
