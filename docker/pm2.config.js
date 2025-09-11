// docker/pm2.config.js
// Distroless-ready PM2 config (no npm/npx at runtime) with list support in SITE and CLANG.
// Multi-site behavior:
// - If SITE has > 1 entries: build sites/tmp.channels.xml from all.channels.xml and run a single grab.
// - If SITE has exactly 1 entry: run a single grab with --site <the-one-site> (no combined).
// - If SITE is empty: fallback to channels.xml or (if ALL_SITES) all.channels.xml.
//
// Precedence:
// - If SITE length >= 1, it ALWAYS takes precedence; ALL_SITES is ignored.

const path = require('path');

function resolveBin(pkgName, binName) {
  // Locate package.json, then resolve the bin file path relative to it.
  const pkgJsonPath = require.resolve(`${pkgName}/package.json`);
  const pkgDir = path.dirname(pkgJsonPath);
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const pkg = require(pkgJsonPath);
  const binField = pkg.bin;
  const rel = (typeof binField === 'string') ? binField : (binField && binField[binName]);
  if (!rel) throw new Error(`Cannot find bin '${binName}' in ${pkgName}/package.json`);
  return path.join(pkgDir, rel);
}

const NODE       = '/nodejs/bin/node';           // Distroless Node entrypoint
const SERVE_JS   = resolveBin('serve', 'serve'); // Static file server
const CHRONOS_JS = resolveBin('@freearhey/chronos', 'chronos'); // Cron-like scheduler
const TSX_JS     = resolveBin('tsx', 'tsx');     // TS/ESM runner

// --- util env helpers ---
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
const ALL_SITES       = envBool(process.env.ALL_SITES, false); // Ignored if SITE is set
const PROXY           = process.env.PROXY;

// Site(s) and lang(s) — same variable names, but accept lists
const SITE_LIST  = parseListFromSingleKey('SITE');
const CLANG_LIST = parseListFromSingleKey('CLANG');
const LANG_CSV   = CLANG_LIST.length ? CLANG_LIST.join(',') : undefined;

// --- build grab args ---
const buildGrabArgs = ({ site, useChannelsXml, combined = false }) => {
  const args = [];

  if (combined) {
    // Combined mode: we prebuild sites/tmp.channels.xml and feed it to grab.ts
    args.push('--channels', 'sites/tmp.channels.xml');
  } else if (site && !useChannelsXml) {
    // Single-site explicit mode
    args.push('--site', site);
  } else if (ALL_SITES) {
    // Fallback when no SITE provided: all channels
    args.push('--channels', 'sites/all.channels.xml');
  } else {
    // Default fallback: curated channels.xml
    args.push('--channels', 'sites/channels.xml');
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

// Helper to create an exec-string for chronos (runs via /bin/sh -c).
// It generates sites/tmp.channels.xml by filtering sites/all.channels.xml for the selected SITE_LIST,
// then spawns a single grab.ts run with --channels sites/tmp.channels.xml.
function makeCombinedExecString(grabArgs) {
  const code = `
    const fs = require('fs');
    const cp = require('child_process');

    // De-duplicate SITE list to avoid redundant filtering
    const sites = Array.from(new Set(${JSON.stringify(SITE_LIST)}));
    const allPath = '/epg/sites/all.channels.xml';
    const tmpPath = '/epg/sites/tmp.channels.xml';

    try {
      const xml = fs.readFileSync(allPath, 'utf8');
      const re = /<channel\\b[\\s\\S]*?<\\/channel>/g;
      const selected = [];
      let m;
      while ((m = re.exec(xml))) {
        const tag = m[0];
        const s = tag.match(/\\bsite="([^"]+)"/);
        if (s && sites.includes(s[1])) selected.push(tag);
      }
      const out = '<?xml version="1.0" encoding="UTF-8"?>\\n<channels>\\n' + selected.join('\\n') + '\\n</channels>\\n';
      fs.writeFileSync(tmpPath, out, 'utf8');
      console.log('[multi-site] tmp.channels.xml written with', selected.length, 'channel nodes for', sites.length, 'site(s).');
    } catch (e) {
      console.error('[multi-site] Failed to build tmp.channels.xml:', e && e.stack || e);
      process.exit(1);
    }

    const args = ${JSON.stringify(grabArgs)};
    const res = cp.spawnSync('${NODE}', ['${TSX_JS}', 'scripts/commands/epg/grab.ts', ...args], {
      stdio: 'inherit',
      cwd: '/epg'
    });
    process.exit(res.status ?? 0);
  `;
  const escaped = code.replace(/(["\\$`])/g, '\\$1').replace(/\n/g, '\\n');
  return `${NODE} -e "${escaped}"`;
}

// Inline version for one-shot RUN_AT_STARTUP (no chronos wrapper)
function makeCombinedInlineCode(grabArgs) {
  return `
    const fs = require('fs');
    const cp = require('child_process');

    const sites = Array.from(new Set(${JSON.stringify(SITE_LIST)}));
    const allPath = '/epg/sites/all.channels.xml';
    const tmpPath = '/epg/sites/tmp.channels.xml';

    try {
      const xml = fs.readFileSync(allPath, 'utf8');
      const re = /<channel\\b[\\s\\S]*?<\\/channel>/g;
      const selected = [];
      let m;
      while ((m = re.exec(xml))) {
        const tag = m[0];
        const s = tag.match(/\\bsite="([^"]+)"/);
        if (s && sites.includes(s[1])) selected.push(tag);
      }
      const out = '<?xml version="1.0" encoding="UTF-8"?>\\n<channels>\\n' + selected.join('\\n') + '\\n</channels>\\n';
      fs.writeFileSync(tmpPath, out, 'utf8');
      console.log('[multi-site] tmp.channels.xml written with', selected.length, 'channel nodes for', sites.length, 'site(s).');
    } catch (e) {
      console.error('[multi-site] Failed to build tmp.channels.xml:', e && e.stack || e);
      process.exit(1);
    }

    const args = ${JSON.stringify(grabArgs)};
    const res = cp.spawnSync('${NODE}', ['${TSX_JS}', 'scripts/commands/epg/grab.ts', ...args], {
      stdio: 'inherit',
      cwd: '/epg'
    });
    process.exit(res.status ?? 0);
  `;
}

// Plain "execute grab once" command (no combined prebuild).
const makeGrabExec = (grabArgs) =>
  [NODE, TSX_JS, 'scripts/commands/epg/grab.ts', ...grabArgs].join(' ');

// ---- PM2 apps ----
const apps = [
  {
    name: 'serve',
    cwd: '/epg',
    script: NODE,
    args: [SERVE_JS, '-l', `tcp://0.0.0.0:${PORT}`, 'public'],
    interpreter: 'node',
    autorestart: true,
    watch: false
  }
];

// Decide mode with precedence:
// - If SITE_LIST.length >= 1 → ignore ALL_SITES entirely.
//   - If >1: combined
//   - If ===1: single-site
// - Else (SITE empty): fallback uses ALL_SITES or channels.xml as before.
const siteCount = SITE_LIST.length;

if (siteCount >= 1) {
  if (siteCount > 1) {
    // --- combined multi-site mode ---
    const grabArgs = buildGrabArgs({ site: undefined, useChannelsXml: false, combined: true });
    const combinedExec = makeCombinedExecString(grabArgs);
    const inlineCode   = makeCombinedInlineCode(grabArgs);

    apps.push({
      name: 'grab',
      cwd: '/epg',
      script: NODE,
      args: [CHRONOS_JS, '--execute', combinedExec, '--pattern', CRON_SCHEDULE, '--log'],
      interpreter: 'node',
      autorestart: true,
      exp_backoff_restart_delay: 5000,
      watch: false
    });

    if (RUN_AT_STARTUP) {
      apps.push({
        name: 'grab-at-startup',
        cwd: '/epg',
        script: NODE,
        args: ['-e', inlineCode],
        interpreter: 'node',
        autorestart: false,
        stop_exit_codes: [0],
        watch: false
      });
    }
  } else {
    // --- single-site mode (no combined) ---
    const theSite = SITE_LIST[0];
    const grabArgs = buildGrabArgs({ site: theSite, useChannelsXml: false, combined: false });
    const grabExec = makeGrabExec(grabArgs);

    apps.push({
      name: `grab:${slug(theSite)}`,
      cwd: '/epg',
      script: NODE,
      args: [CHRONOS_JS, '--execute', grabExec, '--pattern', CRON_SCHEDULE, '--log'],
      interpreter: 'node',
      autorestart: true,
      exp_backoff_restart_delay: 5000,
      watch: false
    });

    if (RUN_AT_STARTUP) {
      apps.push({
        name: `grab-at-startup:${slug(theSite)}`,
        cwd: '/epg',
        script: NODE,
        args: [TSX_JS, 'scripts/commands/epg/grab.ts', ...grabArgs],
        interpreter: 'node',
        autorestart: false,
        stop_exit_codes: [0],
        watch: false
      });
    }
  }
} else {
  // --- fallback mode (SITE empty): channels.xml or ALL_SITES → all.channels.xml ---
  const grabArgs = buildGrabArgs({ site: undefined, useChannelsXml: true, combined: false });
  const grabExec = makeGrabExec(grabArgs);

  apps.push({
    name: 'grab',
    cwd: '/epg',
    script: NODE,
    args: [CHRONOS_JS, '--execute', grabExec, '--pattern', CRON_SCHEDULE, '--log'],
    interpreter: 'node',
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
      interpreter: 'node',
      autorestart: false,
      stop_exit_codes: [0],
      watch: false
    });
  }
}

module.exports = { apps };
