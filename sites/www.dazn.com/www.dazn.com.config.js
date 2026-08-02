const axios = require('axios')
const dayjs = require('dayjs')
const utc = require('dayjs/plugin/utc')

dayjs.extend(utc)

const API_URL =
  'https://rail-router.discovery.indazn.com/eu/v10/Rail?platform=web&id=Livetvschedule&country=de&brand=dazn&languageCode=de'
const IMAGE_API_URL = 'https://image.discovery.indazn.com/eu/v3/linear-channel/none'
const HEADERS = {
  Accept: 'application/json, text/plain, */*',
  Referer: 'https://www.dazn.com/'
}
const XMLTV_IDS = {
  'DAZN 1': 'DAZN1.uk@Germany',
  'DAZN 2': 'DAZN2.uk@Germany',
  'DAZN FAST+': '',
  'DAZN RISE': '',
  'DFB.TV': '',
  'Eurosport 1': 'Eurosport1.fr@Germany',
  'Eurosport 2': 'Eurosport2.fr@Germany',
  'MLB Network': 'MLBNetwork.us@SD',
  'NFL Network': 'NFLNetwork.us@SD',
  'NHL FAST Channel': '',
  'Rally TV': 'RallyTV.us@SD',
  'Red Bull TV': 'RedBullTV.at@DE',
  'SPORTDIGITAL FUSSBALL': 'SportdigitalFUSSBALL.de@SD',
  Unbeaten: 'Unbeaten.us@SD'
}

module.exports = {
  site: 'www.dazn.com',
  days: 3,
  url: API_URL,
  request: {
    headers: HEADERS,
    cache: {
      ttl: 5 * 60 * 1000
    }
  },
  parser({ content, channel, date }) {
    const data = parseData(content)
    const tiles = Array.isArray(data?.Tiles) ? data.Tiles : []
    const tile = tiles.find(item => item.AssetId === channel.site_id)

    if (!tile?.LinearSchedule) return []

    const schedule = tile.LinearSchedule
    const programs = [
      schedule.Now,
      schedule.Next,
      ...(Array.isArray(schedule.Later) ? schedule.Later : [])
    ].filter(Boolean)

    return programs
      .filter(item => item.Start && item.End && dayjs.utc(item.Start).isSame(date, 'day'))
      .map(parseProgram)
  },
  async channels() {
    const { data } = await axios.get(API_URL, { headers: HEADERS })
    const tiles = Array.isArray(data?.Tiles) ? data.Tiles : []

    return tiles
      .filter(tile => tile.AssetId && tile.Title)
      .map(tile => ({
        lang: 'de',
        site_id: tile.AssetId,
        name: tile.Title,
        logo: createImageUrl(tile.LogoImage, {
          resizeAction: 'contain',
          width: 68,
          height: 56,
          format: 'png'
        }),
        xmltv_id: XMLTV_IDS[tile.Title] || ''
      }))
  }
}

function parseData(content) {
  try {
    return typeof content === 'string' ? JSON.parse(content) : content
  } catch {
    return null
  }
}

function parseProgram(item) {
  const program = {
    title: item.Title,
    start: item.Start,
    stop: item.End
  }

  if (item.EpisodeTitle) program.subTitle = item.EpisodeTitle
  if (item.Description) program.description = item.Description
  if (item.EventYear) program.date = item.EventYear
  if (item.TvRating) program.rating = item.TvRating

  const categories = (Array.isArray(item.Genre) ? item.Genre : [])
    .map(genre => genre?.name)
    .filter(Boolean)
  if (item.ProgramType) categories.push(item.ProgramType)
  if (categories.length) program.categories = [...new Set(categories)]

  const image = item.BackgroundImage || item.GradientBackgroundImage || item.Image
  const icon = createImageUrl(image)
  if (icon) program.icon = icon

  return program
}

function createImageUrl(
  image,
  { resizeAction = 'fill', width = 856, height = 481, format = 'webp' } = {}
) {
  if (!image?.Id) return null

  return `${IMAGE_API_URL}/${encodeURIComponent(
    image.Id
  )}/${resizeAction}/center/center/none/80/${width}/${height}/${format}/image?brand=dazn`
}
