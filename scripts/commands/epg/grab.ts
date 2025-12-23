import { Logger, Timer, Collection, Template } from '@freearhey/core'
import epgGrabber, { EPGGrabber, EPGGrabberMock } from 'epg-grabber'
import { loadJs, parseProxy, parseNumber } from '../../core'
import { CurlBody } from 'curl-generator/dist/bodies/body'
import { Channel, Guide, Program } from '../../models'
import { SocksProxyAgent } from 'socks-proxy-agent'
import defaultConfig from '../../default.config'
import { PromisyClass, TaskQueue } from 'cwait'
import { Storage } from '@freearhey/storage-js'
import { CurlGenerator } from 'curl-generator'
import { QueueItem } from '../../types/queue'
import { Option, program } from 'commander'
import { ROOT_DIR, SITES_DIR } from '../../constants'
import { data, loadData } from '../../api'
import dayjs, { Dayjs } from 'dayjs'
import merge from 'lodash.merge'
import fs from 'fs'
import path from 'path'

program
  .addOption(new Option('-s, --site <name>', 'Name of the site to parse'))
  .addOption(
    new Option(
      '-c, --channels <path>',
      'Path to *.channels.xml file (required if the "--site" attribute is not specified)'
    )
  )
  .addOption(new Option('-o, --output <path>', 'Path to output file'))
  .addOption(new Option('-l, --lang <codes>', 'Filter channels by languages (ISO 639-1 codes)'))
  .addOption(
    new Option('-t, --timeout <milliseconds>', 'Override the default timeout for each request')
      .env('TIMEOUT')
      .argParser(parseNumber)
  )
  .addOption(
    new Option('-d, --delay <milliseconds>', 'Override the default delay between request')
      .env('DELAY')
      .argParser(parseNumber)
  )
  .addOption(new Option('-x, --proxy <url>', 'Use the specified proxy').env('PROXY'))
  .addOption(
    new Option(
      '--days <days>',
      'Override the number of days for which the program will be loaded (defaults to the value from the site config)'
    )
      .argParser(parseNumber)
      .env('DAYS')
  )
  .addOption(
    new Option('--maxConnections <number>', 'Limit on the number of concurrent requests')
      .argParser(parseNumber)
      .env('MAX_CONNECTIONS')
  )
  .addOption(new Option('--fillGaps', 'Fill schedule gaps with a dummy program').env('FILL_GAPS'))
  .addOption(new Option('--gzip', 'Create a compressed version of the guide as well').env('GZIP'))
  .addOption(new Option('--curl', 'Display each request as CURL').env('CURL'))
  .addOption(new Option('--debug', 'Enable debug mode').env('DEBUG'))
  .parse()

interface GrabOptions {
  site?: string
  channels?: string
  output?: string
  gzip?: boolean
  curl?: boolean
  debug?: boolean
  maxConnections?: number
  timeout?: number
  delay?: number
  lang?: string
  days?: number
  proxy?: string
  fillGaps?: boolean
}

interface ChannelGroupInfo {
  channelId: string
  site: string
  lang: string
  rangeStart: number
  rangeEnd: number
}

interface ChannelRangeInfo {
  rangeStart: number
  rangeEnd: number
}

const DEFAULT_LANG = 'en'
const DEFAULT_GAP_TITLE = 'Off Air'
const GAP_TITLES_PATH = path.resolve(ROOT_DIR, 'scripts/data/gap_titles.json')

const options: GrabOptions = program.opts()

function parseBoolean(value: unknown, defaultValue = false): boolean {
  if (value === undefined) return defaultValue
  if (typeof value === 'boolean') return value
  const normalized = String(value).trim().toLowerCase()
  if (!normalized) return defaultValue
  return !['0', 'false', 'no', 'off', 'null', 'undefined'].includes(normalized)
}

async function main() {
  if (typeof options.site !== 'string' && typeof options.channels !== 'string')
    throw new Error('One of the arguments must be presented: `--site` or `--channels`')

  const LOG_LEVELS = { info: 3, debug: 4 }
  const logger = new Logger({ level: options.debug ? LOG_LEVELS['debug'] : LOG_LEVELS['info'] })

  logger.info('starting...')
  const globalConfig: epgGrabber.Types.SiteConfig = {}

  if (typeof options.timeout === 'number')
    merge(globalConfig, { request: { timeout: options.timeout } })
  if (options.proxy !== undefined) {
    const proxy = parseProxy(options.proxy)
    if (
      proxy.protocol &&
      ['socks', 'socks5', 'socks5h', 'socks4', 'socks4a'].includes(String(proxy.protocol))
    ) {
      const socksProxyAgent = new SocksProxyAgent(options.proxy)
      merge(globalConfig, {
        request: { httpAgent: socksProxyAgent, httpsAgent: socksProxyAgent }
      })
    } else {
      merge(globalConfig, { request: { proxy } })
    }
  }

  if (typeof options.output === 'string') globalConfig.output = options.output
  if (typeof options.days === 'number') globalConfig.days = options.days
  if (typeof options.delay === 'number') globalConfig.delay = options.delay
  if (typeof options.maxConnections === 'number')
    globalConfig.maxConnections = options.maxConnections
  if (typeof options.curl === 'boolean') globalConfig.curl = options.curl
  if (typeof options.gzip === 'boolean') globalConfig.gzip = options.gzip
  if (typeof options.debug === 'boolean') globalConfig.debug = options.debug

  logger.debug(`config: ${JSON.stringify(globalConfig, null, 2)}`)

  const grabber =
    process.env.NODE_ENV === 'test'
      ? new EPGGrabberMock(globalConfig)
      : new EPGGrabber(globalConfig)

  grabber.client.instance.interceptors.request.use(
    request => {
      logger.debug(`request: ${JSON.stringify(request, null, 2)}`)

      const curl = globalConfig.curl || defaultConfig.curl
      if (curl) {
        type AllowedMethods =
          | 'GET'
          | 'get'
          | 'POST'
          | 'post'
          | 'PUT'
          | 'put'
          | 'PATCH'
          | 'patch'
          | 'DELETE'
          | 'delete'

        const url = request.url || ''
        const method = request.method ? (request.method as AllowedMethods) : 'GET'
        const headers = request.headers
          ? (request.headers.toJSON() as Record<string, string>)
          : undefined
        const body = request.data ? (request.data as CurlBody) : undefined

        const curl = CurlGenerator({ url, method, headers, body })

        console.log(curl)
      }

      return request
    },
    error => Promise.reject(error)
  )

  logger.info('loading channels...')
  const storage = new Storage()

  let files: string[] = []
  if (typeof options.site === 'string') {
    let pattern = path.join(SITES_DIR, options.site, '*.channels.xml')
    pattern = pattern.replace(/\\/g, '/')
    files = await storage.list(pattern)
  } else if (typeof options.channels === 'string') {
    files = await storage.list(options.channels)
  }

  let channelsFromXML = new Collection<Channel>()
  for (const filepath of files) {
    const xml = await storage.load(filepath)
    const parsedChannels = EPGGrabber.parseChannelsXML(xml)
    const _channelsFromXML = new Collection(parsedChannels).map(
      (channel: epgGrabber.Channel) => new Channel(channel.toObject())
    )

    channelsFromXML.concat(_channelsFromXML)
  }

  if (typeof options.lang === 'string') {
    channelsFromXML = channelsFromXML.filter((channel: Channel) => {
      if (!options.lang) return true

      return channel.lang ? options.lang.includes(channel.lang) : false
    })
  }

  logger.info(`found ${channelsFromXML.count()} channel(s)`)

  logger.info('loading api data...')
  await loadData()

  logger.info('creating queue...')
  const queue = new Collection<QueueItem>()
  const channelGroupInfoByKey = new Map<string, ChannelGroupInfo>()
  const channelRangeBySite = new Map<string, ChannelRangeInfo>()

  let index = 0
  for (const channel of channelsFromXML.all()) {
    channel.index = index++
    if (!channel.site || !channel.site_id || !channel.name) continue

    const config = merge({}, defaultConfig, await loadJs(channel.getConfigPath()))

    if (!channel.xmltv_id) channel.xmltv_id = channel.site_id

    const days = globalConfig.days || config.days
    const currDate = dayjs.utc(process.env.CURR_DATE || new Date().toISOString())
    const rangeStart = currDate.startOf('day').valueOf()
    const rangeEnd = currDate.startOf('day').add(days, 'd').valueOf()
    const channelLang = channel.lang || DEFAULT_LANG
    const groupKey = buildGroupKey(channel.xmltv_id, channel.site, channelLang)
    if (!channelGroupInfoByKey.has(groupKey)) {
      channelGroupInfoByKey.set(groupKey, {
        channelId: channel.xmltv_id,
        site: channel.site,
        lang: channelLang,
        rangeStart,
        rangeEnd
      })
    }
    const siteKey = buildSiteKey(channel.xmltv_id, channel.site)
    if (!channelRangeBySite.has(siteKey)) {
      channelRangeBySite.set(siteKey, { rangeStart, rangeEnd })
    }
    const dates = Array.from({ length: days }, (_, day) => currDate.add(day, 'd'))

    dates.forEach((date: Dayjs) => {
      queue.add({
        channel,
        date,
        config: { ...config },
        error: null
      })
    })
  }

  const maxConnections = globalConfig.maxConnections || defaultConfig.maxConnections

  const taskQueue = new TaskQueue(Promise as PromisyClass, maxConnections)

  const channels = new Collection<Channel>()
  const programs = new Collection<Program>()

  let i = 1
  const total = queue.count()

  const requests = queue.map(
    taskQueue.wrap(async (queueItem: QueueItem) => {
      const { channel, config, date } = queueItem

      if (!channel.logo) {
        if (config.logo) {
          channel.logo = await grabber.loadLogo(channel, date)
        } else {
          channel.logo = getLogoForChannel(channel)
        }
      }

      channels.add(channel)

      const channelPrograms = await grabber.grab(
        channel,
        date,
        config,
        (context: epgGrabber.Types.GrabCallbackContext, error: Error | null) => {
          logger.info(
            `  [${i}/${total}] ${context.channel.site} (${context.channel.lang}) - ${
              context.channel.xmltv_id
            } - ${context.date.format('MMM D, YYYY')} (${context.programs.length} programs)`
          )
          if (i < total) i++

          if (error) {
            logger.info(`    ERR: ${error.message}`)
          }
        }
      )

      const _programs = new Collection<epgGrabber.Program>(channelPrograms).map<Program>(
        program => new Program(program.toObject())
      )

      programs.concat(_programs)
    })
  )

  logger.info('run:')

  const timer = new Timer()
  timer.start()

  await Promise.all(requests.all())

  const fillGaps = parseBoolean(options.fillGaps, defaultConfig.fillGaps || false)
  if (fillGaps) {
    const gapTitlesByLang = loadGapTitles()
    fillProgramGaps({
      programs,
      channelGroupInfoByKey,
      channelRangeBySite,
      gapTitlesByLang
    })
  }

  const output = globalConfig.output || defaultConfig.output

  const pathTemplate = new Template(output)

  const channelsGroupedByKey = channels
    .uniqBy((channel: Channel) => `${channel.xmltv_id}:${channel.site}:${channel.lang}`)
    .groupBy((channel: Channel) => {
      return pathTemplate.format({ lang: channel.lang || 'en', site: channel.site || '' })
    })

  const programsGroupedByKey = programs
    .sortBy([(program: Program) => program.channel, (program: Program) => program.start])
    .groupBy((program: Program) => {
      const lang =
        program.titles && program.titles.length && program.titles[0].lang
          ? program.titles[0].lang
          : 'en'

      return pathTemplate.format({ lang, site: program.site || '' })
    })

  const gzip = globalConfig.gzip || defaultConfig.gzip

  for (const groupKey of channelsGroupedByKey.keys()) {
    const groupChannels = new Collection(channelsGroupedByKey.get(groupKey))
    const groupPrograms = new Collection(programsGroupedByKey.get(groupKey))
    const guide = new Guide({
      filepath: groupKey,
      gzip,
      channels: groupChannels,
      programs: groupPrograms
    })

    await guide.save({ logger })
  }

  logger.success(`  done in ${timer.format('HH[h] mm[m] ss[s]')}`)
}

main()

function fillProgramGaps({
  programs,
  channelGroupInfoByKey,
  channelRangeBySite,
  gapTitlesByLang
}: {
  programs: Collection<Program>
  channelGroupInfoByKey: Map<string, ChannelGroupInfo>
  channelRangeBySite: Map<string, ChannelRangeInfo>
  gapTitlesByLang: Record<string, string>
}) {
  const channelLangBySite = buildChannelLangBySite(channelGroupInfoByKey)
  const programsByGroup = new Map<string, Program[]>()
  for (const program of programs.all()) {
    const lang = resolveProgramLang(program, channelLangBySite)
    const key = buildGroupKey(program.channel, program.site, lang)
    const list = programsByGroup.get(key) || []
    list.push(program)
    programsByGroup.set(key, list)
  }

  const gapPrograms: Program[] = []

  for (const [key, groupPrograms] of programsByGroup) {
    const firstProgram = groupPrograms[0]
    if (!firstProgram) continue
    const groupInfo = channelGroupInfoByKey.get(key)
    const lang = groupInfo?.lang || resolveProgramLang(firstProgram, channelLangBySite)
    const channelId = firstProgram.channel
    const site = firstProgram.site
    const rangeInfo =
      groupInfo || channelRangeBySite.get(buildSiteKey(channelId, site)) || getProgramRange(groupPrograms)
    if (!rangeInfo) continue
    if (rangeInfo.rangeEnd <= rangeInfo.rangeStart) continue

    const gapTitle = getGapTitle(lang, gapTitlesByLang)
    const sortedPrograms = groupPrograms
      .filter(program => typeof program.start === 'number' && typeof program.stop === 'number')
      .sort((a, b) => a.start - b.start || a.stop - b.stop)
    let cursor = rangeInfo.rangeStart
    for (const program of sortedPrograms) {
      if (program.stop <= rangeInfo.rangeStart) {
        cursor = Math.max(cursor, program.stop)
        continue
      }
      if (program.start >= rangeInfo.rangeEnd) break
      const programStart = Math.max(program.start, rangeInfo.rangeStart)
      if (programStart > cursor) {
        gapPrograms.push(
          buildGapProgram({ channelId, site, lang }, cursor, Math.min(programStart, rangeInfo.rangeEnd), gapTitle)
        )
      }
      cursor = Math.max(cursor, program.stop)
      if (cursor >= rangeInfo.rangeEnd) break
    }
    if (cursor < rangeInfo.rangeEnd) {
      gapPrograms.push(buildGapProgram({ channelId, site, lang }, cursor, rangeInfo.rangeEnd, gapTitle))
    }
  }

  for (const info of channelGroupInfoByKey.values()) {
    const key = buildGroupKey(info.channelId, info.site, info.lang)
    if (programsByGroup.has(key)) continue
    if (info.rangeEnd <= info.rangeStart) continue
    const gapTitle = getGapTitle(info.lang, gapTitlesByLang)
    gapPrograms.push(
      buildGapProgram(
        { channelId: info.channelId, site: info.site, lang: info.lang },
        info.rangeStart,
        info.rangeEnd,
        gapTitle
      )
    )
  }

  if (gapPrograms.length) {
    programs.concat(new Collection<Program>(gapPrograms))
  }
}

function buildGapProgram(
  info: { channelId: string; site: string; lang: string },
  start: number,
  stop: number,
  title: string
): Program {
  return new Program({
    site: info.site,
    channel: info.channelId,
    start,
    stop,
    titles: [{ value: title, lang: info.lang }]
  })
}

function getProgramRange(programs: Program[]): ChannelRangeInfo | null {
  let rangeStart = Number.POSITIVE_INFINITY
  let rangeEnd = Number.NEGATIVE_INFINITY
  for (const program of programs) {
    if (typeof program.start !== 'number' || typeof program.stop !== 'number') continue
    if (program.start < rangeStart) rangeStart = program.start
    if (program.stop > rangeEnd) rangeEnd = program.stop
  }
  if (!Number.isFinite(rangeStart) || !Number.isFinite(rangeEnd)) return null
  return { rangeStart, rangeEnd }
}

function resolveProgramLang(
  program: Program,
  channelLangBySite?: Map<string, string | null>
): string {
  const lang = program.titles && program.titles.length ? program.titles[0].lang : ''
  if (lang) return lang
  if (channelLangBySite) {
    const fallback = channelLangBySite.get(buildSiteKey(program.channel, program.site))
    if (fallback) return fallback
  }
  return DEFAULT_LANG
}

function buildGroupKey(channelId: string, site: string, lang: string): string {
  return `${channelId}||${site}||${lang}`
}

function buildSiteKey(channelId: string, site: string): string {
  return `${channelId}||${site}`
}

function buildChannelLangBySite(
  channelGroupInfoByKey: Map<string, ChannelGroupInfo>
): Map<string, string | null> {
  const channelLangBySite = new Map<string, string | null>()
  for (const info of channelGroupInfoByKey.values()) {
    const siteKey = buildSiteKey(info.channelId, info.site)
    const current = channelLangBySite.get(siteKey)
    if (!current) {
      channelLangBySite.set(siteKey, info.lang)
      continue
    }
    if (current !== info.lang) {
      channelLangBySite.set(siteKey, null)
    }
  }

  return channelLangBySite
}

function normalizeLang(lang: string): string {
  const normalized = lang.trim().toLowerCase()
  if (!normalized) return DEFAULT_LANG
  const [base] = normalized.split(/[-_]/)
  return base || DEFAULT_LANG
}

function getGapTitle(lang: string, gapTitlesByLang: Record<string, string>): string {
  const normalized = normalizeLang(lang)
  return gapTitlesByLang[normalized] || gapTitlesByLang[DEFAULT_LANG] || DEFAULT_GAP_TITLE
}

function loadGapTitles(): Record<string, string> {
  try {
    const raw = fs.readFileSync(GAP_TITLES_PATH, 'utf8')
    const parsed = JSON.parse(raw)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed
  } catch {
    return {}
  }

  return {}
}

function getLogoForChannel(channel: Channel): string | null {
  const feedData = data.feedsKeyByStreamId.get(channel.xmltv_id)
  if (feedData) {
    const firstLogo = feedData.getLogos().first()
    if (firstLogo) return firstLogo.url
  }

  const [channelId] = channel.xmltv_id.split('@')
  const channelData = data.channelsKeyById.get(channelId)
  if (channelData) {
    const firstLogo = channelData.getLogos().first()
    if (firstLogo) return firstLogo.url
  }

  return null
}
