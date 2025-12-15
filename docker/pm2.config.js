// docker/pm2.config.js
// Distroless-ready PM2 config (no npm/npx at runtime) with list support in SITE and CLANG.
//
// Multi-site behavior (final):
// - If SITE has > 1 entries: sequentially grab each site to /public/<site>/guide.xml, then stream-merge them into /public/guide.xml.
// - If SITE has exactly 1 entry: run ONE grab with --site <the-one-site> -> /public/guide.xml.
// - If SITE is empty: fallback to channels.xml or (if ALL_SITES) all.channels.xml.
//
// Precedence:
// - If SITE length >= 1, it ALWAYS takes precedence; ALL_SITES is ignored.
//
// Notes:
// - No extra runtime deps; combination uses plain Node stdlib.
// - We only scan under /epg/sites/<site>/ (recursive).
// - Combined cache: /tmp/tmp.channels.xml + /tmp/tmp.channels.meta.json
// - IMPORTANT: We sanitize env for child process (remove GZIP/CURL) so only CLI flags control these booleans.

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
        return arr.map((x) => String(x).trim()).filter((x) => x.length > 0);
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

// Site(s) and lang(s)
const SITE_LIST  = parseListFromSingleKey('SITE');
const CLANG_LIST = parseListFromSingleKey('CLANG');
const LANG_CSV   = CLANG_LIST.length ? CLANG_LIST.join(',') : undefined;

// --- build grab args ---
// Only use CLI flags; do NOT rely on env in the child process.
const buildGrabArgs = ({ site, useChannelsXml, combined = false, output }) => {
  const args = [];

  if (combined) {
    args.push('--channels', '/tmp/tmp.channels.xml');
  } else if (site && !useChannelsXml) {
    args.push('--site', site);
  } else if (ALL_SITES) {
    args.push('--channels', 'sites/all.channels.xml');
  } else {
    args.push('--channels', 'sites/channels.xml');
  }

  const outputPath = output || 'public/guide.xml';
  args.push('--output', outputPath);
  args.push('--maxConnections', String(MAX_CONNECTIONS));
  if (DAYS    !== undefined) args.push('--days', String(DAYS));
  if (TIMEOUT !== undefined) args.push('--timeout', String(TIMEOUT));
  if (DELAY   !== undefined) args.push('--delay', String(DELAY));
  if (PROXY)                 args.push('--proxy', PROXY);
  if (LANG_CSV)              args.push('--lang', LANG_CSV);
  if (GZIP)                  args.push('--gzip');
  if (CURL)                  args.push('--curl');

  return args;
};

// --- generic sanitized spawn wrapper (single source of truth) ---
// Runs tsx grab.ts with sanitized env (GZIP/CURL removed) so only CLI flags matter.
function makeSanitizedGrabExec(grabArgs) {
  const code = makeSanitizedGrabInlineCode(grabArgs);
  const b64 = Buffer.from(code, 'utf8').toString('base64');
  return `${NODE} -e "eval(Buffer.from('${b64}','base64').toString())"`;
}
function makeSanitizedGrabInlineCode(grabArgs) {
  return `
    const cp = require('child_process');
    const env = { ...process.env };
    delete env.GZIP;
    delete env.CURL;
    const args = ${JSON.stringify(grabArgs)};
    const res = cp.spawnSync(process.execPath, ['${TSX_JS}', 'scripts/commands/epg/grab.ts', ...args], {
      stdio: 'inherit',
      cwd: '/epg',
      env
    });
    process.exit(res.status ?? 0);
  `;
}

// --- multi-site runner: per-site guides + merged guide.xml ---
function buildMultiSiteInlineCode(siteList) {
  const ARG_SITE = '__SITE_PLACEHOLDER__';
  const ARG_OUT  = '__OUTPUT_PLACEHOLDER__';
  const grabArgsTemplate = buildGrabArgs({
    site: ARG_SITE,
    useChannelsXml: false,
    combined: false,
    output: ARG_OUT
  });

  return String.raw`
    const fs = require('fs');
    const path = require('path');
    const cp = require('child_process');

    const sites = ${JSON.stringify(siteList)};
    const template = ${JSON.stringify(grabArgsTemplate)};
    const ARG_SITE = '${ARG_SITE}';
    const ARG_OUT  = '${ARG_OUT}';

    const makeArgs = (site, output) => template.map((arg) => {
      if (arg === ARG_SITE) return site;
      if (arg === ARG_OUT)  return output;
      return arg;
    });

    async function grabOne(site) {
      const outputDir = path.join('/epg/public', site);
      const output    = path.join(outputDir, 'guide.xml');
      fs.mkdirSync(outputDir, { recursive: true });

      const env = { ...process.env };
      delete env.GZIP;
      delete env.CURL;

      const args = makeArgs(site, output);
      const res = cp.spawnSync(process.execPath, ['${TSX_JS}', 'scripts/commands/epg/grab.ts', ...args], {
        stdio: 'inherit',
        cwd: '/epg',
        env
      });
      if (res.status !== 0) {
        console.warn('[multi-site] grab failed for', site, 'status', res.status);
      }
      return output;
    }

    function stripTvEnvelope(file, writer) {
      return new Promise((resolve) => {
        const stream = fs.createReadStream(file, { encoding: 'utf8' });
        stream.on('data', (chunk) => {
          writer.write(
            chunk
              .replace(/<\\?xml[^>]*?>/gi, '')
              .replace(/<!DOCTYPE[^>]*?>/gi, '')
              .replace(/<tv[^>]*>/gi, '')
              .replace(/<\\/tv>/gi, '')
          );
        });
        stream.on('end', resolve);
        stream.on('error', (err) => {
          console.warn('[multi-site] merge read failed:', file, err && err.message || err);
          resolve();
        });
      });
    }

    async function mergeGuides(sources, dest) {
      const writer = fs.createWriteStream(dest, { encoding: 'utf8' });
      writer.write('<?xml version="1.0" encoding="UTF-8"?>\\n<tv>\\n');
      for (const src of sources) {
        if (!fs.existsSync(src)) {
          console.warn('[multi-site] skipping missing guide:', src);
          continue;
        }
        await stripTvEnvelope(src, writer);
      }
      writer.write('</tv>\\n');
      await new Promise((resolve, reject) => {
        writer.end(resolve);
        writer.on('error', reject);
      }).catch((err) => {
        console.warn('[multi-site] merge write failed:', err && err.message || err);
      });
    }

    async function main() {
      const outputs = [];
      for (const site of sites) {
        outputs.push(await grabOne(site));
      }
      await mergeGuides(outputs, '/epg/public/guide.xml');
      console.log('[multi-site] merged', outputs.length, 'guide(s) into /epg/public/guide.xml');
    }

    main().catch((err) => {
      console.error('[multi-site] fatal error:', err && err.stack || err);
      process.exit(1);
    });
  `;
}

function makeMultiSiteExecString(siteList) {
  const code = buildMultiSiteInlineCode(siteList);
  const b64  = Buffer.from(code, 'utf8').toString('base64');
  return `${NODE} -e "eval(Buffer.from('${b64}','base64').toString())"`;
}

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

// Precedence & modes:
// - SITE >=1 → ignore ALL_SITES
//   - SITE >1 → per-site guides + merged guide.xml
//   - SITE =1 → single-site
// - SITE =0 → fallback
const siteCount = SITE_LIST.length;

if (siteCount >= 1) {
  if (siteCount > 1) {
    // multi-site mode: per-site outputs + merged guide.xml
    const inlineCode = buildMultiSiteInlineCode(SITE_LIST);
    const execStr    = makeMultiSiteExecString(SITE_LIST);

    apps.push({
      name: 'grab',
      cwd: '/epg',
      script: NODE,
      args: [CHRONOS_JS, '--execute', execStr, '--pattern', CRON_SCHEDULE, '--log'],
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
        args: ['-e', inlineCode],
        interpreter: 'none',
        autorestart: false,
        stop_exit_codes: [0],
        watch: false
      });
    }
  } else {
    // single-site mode (no combine)
    const theSite  = SITE_LIST[0];
    const grabArgs = buildGrabArgs({ site: theSite, useChannelsXml: false, combined: false });

    const execStr  = makeSanitizedGrabExec(grabArgs);
    const inline   = makeSanitizedGrabInlineCode(grabArgs);

    apps.push({
      name: `grab:${slug(theSite)}`,
      cwd: '/epg',
      script: NODE,
      args: [CHRONOS_JS, '--execute', execStr, '--pattern', CRON_SCHEDULE, '--log'],
      interpreter: 'none',
      autorestart: true,
      exp_backoff_restart_delay: 5000,
      watch: false
    });

    if (RUN_AT_STARTUP) {
      apps.push({
        name: `grab-at-startup:${slug(theSite)}`,
        cwd: '/epg',
        script: NODE,
        args: ['-e', inline],
        interpreter: 'none',
        autorestart: false,
        stop_exit_codes: [0],
        watch: false
      });
    }
  }
} else {
  // fallback mode (SITE empty)
  const grabArgs = buildGrabArgs({ site: undefined, useChannelsXml: true, combined: false });
  const execStr  = makeSanitizedGrabExec(grabArgs);
  const inline   = makeSanitizedGrabInlineCode(grabArgs);

  apps.push({
    name: 'grab',
    cwd: '/epg',
    script: NODE,
    args: [CHRONOS_JS, '--execute', execStr, '--pattern', CRON_SCHEDULE, '--log'],
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
      args: ['-e', inline],
      interpreter: 'none',
      autorestart: false,
      stop_exit_codes: [0],
      watch: false
    });
  }
}

module.exports = { apps };
