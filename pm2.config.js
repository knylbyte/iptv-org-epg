const isTruthy = (value) => {
  if (value === undefined) return false;
  const normalized = String(value).trim().toLowerCase();
  if (!normalized) return false;
  return !['0', 'false', 'no', 'off', 'null', 'undefined'].includes(normalized);
};

const langArg = process.env.CLANG ? `--lang=${process.env.CLANG}` : '';
const fillGapsArg = isTruthy(process.env.FILL_GAPS) ? '--fillGaps' : '';
const extraArgs = [langArg, fillGapsArg].filter(Boolean).join(' ');
const extraArgsWithSpace = extraArgs ? ` ${extraArgs}` : '';

const grab = process.env.SITE
  ? `npm run grab -- --site=${process.env.SITE}${extraArgsWithSpace} --output=public/guide.xml`
  : `npm run grab -- --channels=channels.xml${extraArgsWithSpace} --output=public/guide.xml`


const apps = [
  {
    name: 'serve',
    script: 'npx serve -- public',
    instances: 1,
    watch: false,
    autorestart: true
  },
  {
    name: 'grab',
    script: `npx chronos -e "${grab}" -p "${process.env.CRON_SCHEDULE}" -l`,
    instances: 1,
    watch: false,
    autorestart: true
  }
];

if (process.env.RUN_AT_STARTUP === 'true') {
  apps.push({
    name: 'grab-at-startup',
    script: grab,
    instances: 1,
    autorestart: false,
    watch: false,
    max_restarts: 1
  });
}

module.exports = { apps };
