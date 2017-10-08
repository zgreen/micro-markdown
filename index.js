const fs = require("fs");
const https = require("https");
const { promisify } = require("util");

const frontMatter = require("front-matter");
const { parse } = require("query-string");
const marked = require("marked");
const micro = require("micro");

const { run, send } = micro;
const asyncReadFile = promisify(fs.readFile);
const asyncReadDir = promisify(fs.readdir);

let currentCache;

function createMicroServer() {
  const isDev = process.env.NODE_ENV === "dev";
  let cert;
  if (isDev) {
    cert = require("openssl-self-signed-certificate");
  }
  const serverOpts = {
    key: isDev ? cert.key : process.env.key,
    cert: isDev ? cert.cert : process.env.cert
  };
  return fn => https.createServer(serverOpts, (req, res) => run(req, res, fn));
}

function notFound(res) {
  return send(
    res,
    404,
    templateFunction(
      `<h1>Sorry, that page wasn't found.</h1>`,
      "Page Not Found"
    )
  );
}

function parseText(text) {
  const { attributes, body } = frontMatter(text);
  const { description, title } = attributes;
  return { body, description, title };
}

/**
 * Match routes against a RegEx.
 */
function routesRegExp(routeMap, apiRoutes) {
  return new RegExp(
    Object.keys(apiRoutes)
      .concat(routeMap || [])
      .map(keys => apiRoutes[keys])
      .join("|")
  );
}

function templateFunction(
  body,
  title = "Document",
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
</html>`;
}

async function attemptTextCacheGet(cache, filepath, fallback) {
  if (!filepath) {
    return;
  }
  let text = await cache.string.get(filepath);
  if (!text) {
    text = await fallback(filepath);
    cache.string.set(filepath, text);
  }
  return text;
}

async function establishCache(client) {
  if (currentCache) {
    return currentCache;
  }
  const redis = require("redis");
  const host = process.env.REDIS_PORT_6379_TCP_ADDR || "redis";
  const port = process.env.REDIS_PORT_6379_TCP_PORT || 6379;
  client = client || redis.createClient(port, host);

  const cacheDefault = {
    didError: false,
    array: {
      get: () => null,
      add: () => null
    },
    string: {
      get: () => null,
      set: () => null
    }
  };
  const error = () => {
    return new Promise(resolve => {
      client.on("error", () => {
        const cacheUpdate = Object.keys(cacheDefault).reduce((acc, key) => {
          let update = { [key]: cacheDefault[key] };
          switch (key) {
            case "array":
              update = { array: { get: () => null, add: () => null } };
              break;
            case "string":
              update = { string: { get: () => null, set: () => null } };
              break;
          }
          return Object.assign({}, acc, update);
        }, {});
        client.quit();
        resolve(cacheUpdate);
      });
    });
  };
  const ready = () => {
    return new Promise(resolve => {
      client.on("ready", () => {
        const cacheUpdate = Object.keys(cacheDefault).reduce((acc, key) => {
          let update = { [key]: cacheDefault[key] };
          switch (key) {
            case "array":
              update = {
                array: {
                  get: promisify(client.smembers).bind(client),
                  add: promisify(client.sadd).bind(client)
                }
              };
              break;
            case "string":
              update = {
                string: {
                  get: promisify(client.get).bind(client),
                  set: promisify(client.set).bind(client)
                }
              };
              break;
          }
          return Object.assign({}, acc, update);
        }, {});
        resolve(cacheUpdate);
      });
    });
  };
  const result = await Promise.race([error(), ready()]);
  currentCache = result;
  return currentCache;
}

async function ok(options) {
  const args = Object.assign({}, options, { template: templateFunction });
  const {
    apiRoutes,
    filepath,
    path,
    res,
    template,
    string,
    target,
    cache
  } = args;
  const text = string || (await attemptTextCacheGet(cache, filepath, readFile));
  switch (true) {
    case target === "raw" || path.indexOf(apiRoutes.raw) === 0:
      return text;
    case target === "json" || path.indexOf(apiRoutes.json) === 0: {
      const { body, description, title } = parseText(text);
      return {
        body,
        description,
        title
      };
    }
    case target === "html" || path.indexOf(apiRoutes.html) === 0: {
      const { body, description, title } = parseText(text);
      return template(marked(body), title);
    }
    default:
      return notFound(res);
  }
}

async function readFile(path) {
  try {
    return await asyncReadFile(path, "utf8");
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
}

async function readFiles(textsDir) {
  try {
    const files = await asyncReadDir(textsDir, "utf8");
    return files.filter(filename => filename.substr(-3) === ".md");
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
}

async function attemptCacheReadFiles(cache, textsDir) {
  const key = "text-paths";
  let texts = await cache.array.get(key);
  if (!texts || texts.length === 0) {
    texts = await readFiles(textsDir);
    texts.forEach(path => {
      cache.array.add(key, path);
    });
  }
  return texts;
}

async function customHandler(args) {
  const { handler, res, path, target, cache, apiRoutes } = args;
  let string;
  try {
    string = await handler();
    if (typeof string !== "string") {
      console.error(`${string} is not a string.`);
      return notFound(res);
    }
  } catch (err) {
    return notFound(res);
  }
  return ok({
    apiRoutes,
    res,
    path,
    string,
    target,
    cache
  });
}

const server = (options = { routes: {} }) => {
  const defaultNamespace = `/mm/api/v1`;
  const args = Object.assign(
    {},
    {
      apiRoutes: {
        raw: `${defaultNamespace}/raw`,
        json: `${defaultNamespace}/json`,
        html: `${defaultNamespace}/html`
      },
      cacheClient: establishCache,
      textsDir: "./texts"
    },
    options
  );
  const {
    apiRoutes,
    auth,
    namespace,
    routes,
    templateFunction,
    routeMaps,
    cacheClient,
    textsDir
  } = args;
  return createMicroServer()(async (req, res) => {
    if (auth && req.headers.authorization !== auth) {
      return send(res, 401, "Unauthorized");
    }
    const cache = await cacheClient();
    const [path, search] = req.url.split("?");
    const mappedRoute = routeMaps.default(path).route;
    const { target } = routeMaps.default(path);
    let endpoint = routeMaps.default(path).route;
    if (!endpoint) {
      [, endpoint] = path.split(routesRegExp(mappedRoute, apiRoutes));
    }
    // Bail if this isn't a desired endpoint
    if (!endpoint) {
      return notFound(res);
    }
    // Check if the path matches a route from the config
    if (routes[endpoint.substr(1)]) {
      const keys = Object.keys(routes);
      const { handler } = routes[endpoint.substr(1)];
      let { string } = routes[endpoint.substr(1)];
      if (string) {
        return ok({ apiRoutes, res, path, string, target, cache });
      }
      if (handler) {
        return await customHandler({
          handler,
          res,
          path,
          target,
          cache,
          apiRoutes
        });
      }
    } else {
      // Else read the texts.
      let texts = await attemptCacheReadFiles(cache, textsDir);
      const match = texts.indexOf(`${endpoint.substr(1)}.md`);
      if (match === -1) {
        return notFound(res);
      }
      return ok({
        apiRoutes,
        filepath: `${textsDir}/${texts[match]}`,
        path,
        res,
        target,
        cache
      });
    }
  });
};

module.exports = server;
exports = server;
exports.default = server;
exports.cacheClient = establishCache;
