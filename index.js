const fs = require('fs')
const { promisify } = require('util')

const frontMatter = require('front-matter')
const marked = require('marked')
const micro = require('micro')
const redis = require('redis')

const { run, send } = micro
const asyncReadFile = promisify(fs.readFile)
const asyncReadDir = promisify(fs.readdir)

let currentCache
let didFlush = false

function createMicroServer () {
  const isDev = process.env.NODE_ENV === 'dev'
  let cert
  if (isDev) {
    cert = require('openssl-self-signed-certificate')
  }
  // If we have these, use https
  if (isDev || (process.env.key && process.env.cert)) {
    const https = require('https')
    const serverOpts = {
      key: isDev ? cert.key : process.env.key,
      cert: isDev ? cert.cert : process.env.cert
    }
    return fn => https.createServer(serverOpts, (req, res) => run(req, res, fn))
  }
  // else use http
  const http = require('http')
  return fn => http.createServer((req, res) => run(req, res, fn))
}

function matchWithParams (paths, endpoint) {
  const endpointSplits = endpoint.split('/')
  const match = paths.find(path => {
    return path.length && endpointSplits[0] === path.split('/')[0]
  })
  if (match && match.indexOf(':') !== -1) {
    const pathSplits = match.split('/:')
    return pathSplits
      .slice(1)
      .reduce(
        (acc, cur, idx) =>
          Object.assign({}, acc, { [cur]: endpointSplits[idx + 1] }),
        {}
      )
  }
  return {}
}

function notFound (res) {
  return send(
    res,
    404,
    templateFunction(
      `<h1>Sorry, that page wasn't found.</h1>`,
      'Page Not Found'
    )
  )
}

/**
 * Parse some text using `frontmatter`.
 *
 * @param {string} text Markdown text.
 * @return {Object} Parsed frontmatter.
 */
function parseText (text) {
  const { attributes, body } = frontMatter(text)
  const { description, title } = attributes
  return {
    body,
    description,
    title
  }
}

/**
 * Match routes against a RegEx.
 */
function routesRegExp (routeMap, apiRoutes) {
  return new RegExp(
    Object.keys(apiRoutes)
      .concat(routeMap || [])
      .map(keys => apiRoutes[keys])
      .join('|')
  )
}

function templateFunction (
  body,
  title = 'Document',
  styles = `body{font-family: monospace}`
) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="X-UA-Compatible" content="ie=edge">
  <title>${title}</title>
  <style>${styles}</style>
</head>
<body>
  ${body}
</body>
</html>`
}

async function attemptTextCacheGet (cache, filepath, fallback = readFile) {
  if (!filepath) {
    return
  }
  let text
  try {
    text = await cache.string.get(filepath)
  } catch (e) {
    text = await fallback(filepath)
  }
  if (!text) {
    text = await fallback(filepath)
    if (cache) {
      cache.string.set(filepath, text)
    }
  }
  return text
}

async function establishCache (shouldFlush = true, client) {
  if (currentCache) {
    if (shouldFlush && !didFlush) {
      currentCache.flushall(err => {
        if (!err) {
          didFlush = true
          console.log('Cache flushed.')
        }
      })
    }
    return currentCache
  }

  const host = process.env.REDIS_HOST || 'redis'
  const port = process.env.REDIS_PORT || 6379
  const password = process.env.REDIS_PASSWORD
  client = client || redis.createClient({ host, password, port })

  const cacheDefault = {
    didError: false,
    array: {
      get: () => null,
      add: () => null
    },
    flushall: () => null,
    string: {
      get: () => null,
      set: () => null
    }
  }
  const error = () => {
    return new Promise(resolve => {
      client.on('error', () => {
        console.error('Cache client error.')
        const cacheUpdate = Object.keys(cacheDefault).reduce((acc, key) => {
          let update = { [key]: cacheDefault[key] }
          switch (key) {
            case 'array':
              update = { array: { get: () => null, add: () => null } }
              break
            case 'flushall':
              update = { flushall: () => null }
              break
            case 'string':
              update = { string: { get: () => null, set: () => null } }
              break
          }
          return Object.assign({}, acc, update)
        }, {})
        client.quit()
        resolve(cacheUpdate)
      })
    })
  }
  const ready = () => {
    return new Promise(resolve => {
      client.on('ready', () => {
        console.log(`Cache client ready.`)
        const cacheUpdate = Object.keys(cacheDefault).reduce((acc, key) => {
          let update = { [key]: cacheDefault[key] }
          switch (key) {
            case 'array':
              update = {
                array: {
                  get: promisify(client.smembers).bind(client),
                  add: promisify(client.sadd).bind(client)
                }
              }
              break
            case 'flushall':
              update = { flushall: client.flushall.bind(client) }
              break
            case 'string':
              update = {
                string: {
                  get: promisify(client.get).bind(client),
                  set: promisify(client.set).bind(client)
                }
              }
              break
          }
          return Object.assign({}, acc, update)
        }, {})
        resolve(cacheUpdate)
      })
    })
  }
  const result = await Promise.race([error(), ready()])
  currentCache = result
  return currentCache
}

async function ok (options) {
  const {
    apiRoutes,
    filepath,
    path,
    res,
    template,
    string,
    target,
    cache,
    markedString,
    styles
  } = options
  let { title } = options
  const text =
    string ||
    markedString ||
    (await attemptTextCacheGet(cache, filepath, readFile))
  const caseHTML = target === 'html' || path.indexOf(apiRoutes.html) === 0
  switch (true) {
    case target === 'raw' || path.indexOf(apiRoutes.raw) === 0:
      return text
    case target === 'json' || path.indexOf(apiRoutes.json) === 0: {
      const { body, description } = parseText(text)
      ;({ title } = parseText(text))
      return {
        body,
        description,
        title
      }
    }
    case text && caseHTML: {
      const parsedText = parseText(text)
      const { body } = parsedText
      ;({ title } = parsedText)
      return template(marked(body), title, styles)
    }
    case markedString && caseHTML: {
      return template(markedString, title, styles)
    }
    default:
      return notFound(res)
  }
}

async function readFile (path) {
  try {
    return await asyncReadFile(path, 'utf8')
  } catch (err) {
    console.error(err)
    process.exit(1)
  }
}

async function readFiles (textsDir) {
  try {
    const files = await asyncReadDir(textsDir, 'utf8')
    return files.filter(filename => filename.substr(-3) === '.md')
  } catch (err) {
    console.error(err)
    return []
  }
}

async function attemptCacheReadFiles (cache, textsDir = './texts') {
  const key = 'text-paths'
  let texts = await cache.array.get(key)
  if (!texts || texts.length === 0) {
    texts = await readFiles(textsDir)
    texts.forEach(path => {
      cache.array.add(key, path)
    })
  }
  return texts
}

async function customHandler (args) {
  const {
    handler,
    res,
    path,
    cache,
    apiRoutes,
    params,
    styles,
    template,
    title
  } = args
  let { target } = args
  let markedString
  let string
  try {
    const result = await handler()
    if (result.raw) {
      // @TODO This should probably all be bound to the handler.
      string = await result.raw({
        url: path,
        params,
        attemptTextCacheGet: attemptTextCacheGet.bind(null, cache),
        attemptCacheReadFiles: attemptCacheReadFiles.bind(null, cache),
        frontMatter
      })
      target = 'raw'
    } else {
      const html = result.html || (string => string)
      const { markdown } = result
      markedString = await html(marked(markdown))
      if (typeof markedString !== 'string') {
        console.error(`${markedString} is not a string.`)
        return notFound(res)
      }
    }
  } catch (err) {
    return notFound(res)
  }
  return ok({
    apiRoutes,
    res,
    path,
    target,
    cache,
    markedString,
    string,
    styles,
    template,
    title
  })
}

const server = options => {
  const defaultNamespace = `/mm/api/v1`
  const args = Object.assign(
    {},
    {
      apiRoutes: {
        raw: `${defaultNamespace}/raw`,
        json: `${defaultNamespace}/json`,
        html: `${defaultNamespace}/html`
      },
      routes: {},
      routeMaps: {
        default: route => route
      },
      cacheClient: establishCache,
      shouldFlush: true,
      markedOptions: {},
      template: templateFunction,
      textsDir: './texts'
    },
    options
  )
  const {
    apiRoutes,
    auth,
    routeMaps,
    cacheClient,
    shouldFlush,
    markedOptions,
    template,
    textsDir,
    title
  } = args
  marked.setOptions(markedOptions)
  // Allow for `/` route prefixes
  const routes = Object.keys(args.routes).reduce(
    (acc, key) =>
      Object.assign({}, acc, {
        [key.indexOf('/') === 0 ? key.substr(1) : key]: args.routes[key]
      }),
    {}
  )
  const asyncServer = async (req, res) => {
    if (auth && req.headers.authorization !== auth) {
      return send(res, 401, 'Unauthorized')
    }
    const cache = await cacheClient(shouldFlush)
    const [path] = req.url.split('?')
    const mappedRoute = routeMaps.default(path).route
    const { target } = routeMaps.default(path)
    let endpoint = routeMaps.default(path).route
    if (!endpoint) {
      ;[, endpoint] = path.split(routesRegExp(mappedRoute, apiRoutes))
    }
    // Bail if this isn't a desired endpoint
    if (!endpoint) {
      return notFound(res)
    }
    const params = matchWithParams(Object.keys(routes), endpoint.substr(1))
    // Check if the path matches a route from the config
    if (routes[endpoint.substr(1)] || Object.keys(params).length) {
      const key = params
        ? Object.keys(params).reduce(
          (acc, cur) => `${acc}/:${cur}`,
          endpoint.split('/')[1]
        )
        : endpoint.substr(1)
      const { handler, styles, title } = routes[key]
      let { string } = routes[key]
      if (string) {
        return ok({ apiRoutes, res, path, string, target, title, cache })
      }
      if (handler) {
        return customHandler({
          handler,
          res,
          path,
          target,
          cache,
          apiRoutes,
          params,
          styles,
          template,
          title
        })
      }
    } else {
      // Else read the texts.
      let texts = await attemptCacheReadFiles(cache, textsDir)
      const match = texts.indexOf(`${endpoint.substr(1)}.md`)
      if (match === -1) {
        return notFound(res)
      }
      return ok({
        apiRoutes,
        filepath: `${textsDir}/${texts[match]}`,
        path,
        res,
        target,
        cache,
        template,
        title
      })
    }
  }
  return createMicroServer()(asyncServer)
}

module.exports = server
exports = server
exports.default = server
exports.cacheClient = establishCache
