// docker/pm2.config.js
// Distroless-ready PM2 config (no npm/npx at runtime) with list support in SITE and CLANG.
//
// Multi-site behavior (final):
// - If SITE has > 1 entries: build /tmp/tmp.channels.xml by scanning /epg/sites/<site>/** for *.channels.xml,
//   extracting <channel> nodes into a single combined channels file, then run ONE grab with --channels /tmp/tmp.channels.xml.
//   Caching: reuse /tmp/tmp.channels.xml only if /tmp/tmp.channels.meta.json matches SITE list, file list, and max mtime.
// - If SITE has exactly 1 entry: run ONE grab with --site <the-one-site> (no combine step).
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
const buildGrabArgs = ({ site, useChannelsXml, combined = false }) => {
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

  args.push('--output', 'public/guide.xml');
  args.push('--maxConnections', String(MAX_CONNECTIONS));
  if (DAYS    !== undefined) args.push('--days', String(DAYS));
  if (TIMEOUT !== undefined) args.push('--timeout', String(TIMEOUT));
  if (DELAY   !== undefined) args.push('--delay', String(DELAY));
  if (PROXY)                  args.push('--proxy', PROXY);
  if (LANG_CSV)               args.push('--lang', LANG_CSV);

  // Explicit booleans via CLI flags only
  if (GZIP) args.push('--gzip');
  if (CURL) args.push('--curl');

  return args;
};

// --- generic sanitized spawn wrapper (single source of truth) ---
// Runs tsx grab.ts with sanitized env (GZIP/CURL removed) so only CLI flags matter.
function makeSanitizedGrabExec(grabArgs) {
  const code = `
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
  const escaped = code.replace(/(["\\$`])/g, '\\$1').replace(/\n/g, '\\n');
  return `${NODE} -e "${escaped}"`;
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

// --- combined builder with mtime-based cache (no XML markers) ---
function buildCombinerCode() {
  return `
    const fs = require('fs');
    const path = require('path');
    const cp = require('child_process');

    const sites = Array.from(new Set(${JSON.stringify(SITE_LIST)})).sort();
    const baseDir  = '/epg/sites';
    const tmpXml   = '/tmp/tmp.channels.xml';
    const tmpMeta  = '/tmp/tmp.channels.meta.json';

    function walk(dir, out) {
      let entries;
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const ent of entries) {
        const p = path.join(dir, ent.name);
        if (ent.isDirectory()) {
          walk(p, out);
        } else if (/\\.channels\\.xml$/i.test(ent.name)) {
          out.push(p);
        }
      }
    }

    function collectSources(siteList) {
      const files = [];
      for (const s of siteList) {
        const siteDir = path.join(baseDir, s);
        try {
          const st = fs.statSync(siteDir);
          if (st.isDirectory()) {
            walk(siteDir, files);
          } else {
            console.warn('[multi-site] Not a directory:', siteDir);
          }
        } catch {
          console.warn('[multi-site] Missing site directory:', siteDir);
        }
      }
      files.sort();
      let maxMtimeMs = 0;
      for (const f of files) {
        try {
          const st = fs.statSync(f);
          const m  = Number(st.mtimeMs) || 0;
          if (m > maxMtimeMs) maxMtimeMs = m;
        } catch {}
      }
      return { files, maxMtimeMs };
    }

    function readMeta() {
      try {
        if (!fs.existsSync(tmpXml) || !fs.existsSync(tmpMeta)) return null;
        const meta = JSON.parse(fs.readFileSync(tmpMeta, 'utf8'));
        if (!meta || !Array.isArray(meta.sites) || !Array.isArray(meta.files)) return null;
        return meta;
      } catch {
        return null;
      }
    }

    function writeMeta(meta) {
      try { fs.writeFileSync(tmpMeta, JSON.stringify(meta, null, 2), 'utf8'); } catch {}
    }

    const current = collectSources(sites);
    let reuse = false;
    const meta = readMeta();
    if (meta) {
      const sameSites = JSON.stringify(meta.sites) === JSON.stringify(sites);
      const sameFiles = JSON.stringify(meta.files) === JSON.stringify(current.files);
      const upToDate  = Number(meta.maxMtimeMs) >= current.maxMtimeMs;
      if (sameSites && sameFiles && upToDate) {
        reuse = true;
        console.log('[multi-site] Reusing cached /tmp/tmp.channels.xml');
      }
    }

    if (!reuse) {
      const chunks = [];
      for (const f of current.files) {
        try {
          const xml = fs.readFileSync(f, 'utf8');
          const m = xml.match(/<channels[^>]*>([\\s\\S]*?)<\\/channels>/i);
          let inner = m ? m[1] : null;
          if (!inner) {
            const list = xml.match(/<channel\\b[\\s\\S]*?<\\/channel>/gi);
            if (list) inner = list.join('\\n');
          }
          if (inner) chunks.push(inner.trim()); else console.warn('[multi-site] no <channel> in', f);
        } catch (e) {
          console.warn('[multi-site] read failed:', f, e && e.message || e);
        }
      }
      const body = chunks.length ? (chunks.join('\\n') + '\\n') : '';
      const out  = '<?xml version="1.0" encoding="UTF-8"?>\\n<channels>\\n' + body + '</channels>\\n';
      fs.writeFileSync(tmpXml, out, 'utf8');
      console.log('[multi-site] Rebuilt /tmp/tmp.channels.xml with', chunks.length, 'chunk(s) from', current.files.length, 'file(s).');
      writeMeta({ version: 1, builtAt: Date.now(), sites, files: current.files, maxMtimeMs: current.maxMtimeMs });
    }

    // sanitized spawn: remove GZIP/CURL from env so only CLI flags matter
    const env = { ...process.env };
    delete env.GZIP;
    delete env.CURL;

    const args = ${JSON.stringify(buildGrabArgs({ site: undefined, useChannelsXml: false, combined: true }))};
    const res = cp.spawnSync(process.execPath, ['${TSX_JS}', 'scripts/commands/epg/grab.ts', ...args], {
      stdio: 'inherit',
      cwd: '/epg',
      env
    });
    process.exit(res.status ?? 0);
  `;
}
function makeCombinedExecString() {
  const code = buildCombinerCode();
  const escaped = code.replace(/(["\\$`])/g, '\\$1').replace(/\n/g, '\\n');
  return `${NODE} -e "${escaped}"`;
}

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

// Precedence & modes:
// - SITE >=1 → ignore ALL_SITES
//   - SITE >1 → combined
//   - SITE =1 → single-site
// - SITE =0 → fallback
const siteCount = SITE_LIST.length;

if (siteCount >= 1) {
  if (siteCount > 1) {
    // combined multi-site mode (cached in /tmp)
    const combinedExec = makeCombinedExecString();
    const inlineCode   = buildCombinerCode();

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
        args: ['-e', inline],
        interpreter: 'node',
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
      args: ['-e', inline],
      interpreter: 'node',
      autorestart: false,
      stop_exit_codes: [0],
      watch: false
    });
  }
}

module.exports = { apps };
