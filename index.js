const fs = require("fs");
const { promisify } = require("util");

const { parse } = require("query-string");
const marked = require("marked");
const micro = require("micro");
const redis = require("redis");

const cache = redis.createClient();
const { send } = micro;
const lexer = new marked.Lexer();
const asyncReadFile = promisify(fs.readFile);
const asyncReadDir = promisify(fs.readdir);
const asyncCacheGet = promisify(cache.get).bind(cache);
const asyncCacheSet = promisify(cache.set).bind(cache);
const asyncCacheSmembers = promisify(cache.smembers).bind(cache);

const textsDir = "./texts";
const defaultNamespace = `/mm/api/v1`;
const apiRoutes = {
  raw: `${defaultNamespace}/raw`,
  json: `${defaultNamespace}/json`,
  html: `${defaultNamespace}/html`
};

function notFound(res) {
  return send(res, 404, "Not found");
}

function parseTitle(text) {
  return lexer
    .lex(text)
    .find(token => token.type === "heading" && token.depth === 1).text;
}

function routesRegExp() {
  return new RegExp(
    Object.keys(apiRoutes)
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

async function attemptTextCacheGet(filepath, fallback) {
  let text = await asyncCacheGet(filepath);
  if (!text) {
    console.log("read file from disk");
    text = await fallback(filepath);
    asyncCacheSet(filepath, text);
  }
  return text;
}

async function ok(options) {
  const args = Object.assign({}, options, { template: templateFunction });
  const { filepath, path, res, template, string } = args;
  const text = string || (await attemptTextCacheGet(filepath, readFile));
  switch (true) {
    case path.indexOf(apiRoutes.raw) === 0:
      return text;
    case path.indexOf(apiRoutes.json) === 0:
      return {
        body: text,
        title: parseTitle(text)
      };
    case path.indexOf(apiRoutes.html) === 0:
      return template(marked(text));
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

async function readFiles() {
  try {
    const files = await asyncReadDir(textsDir, "utf8");
    return files.filter(filename => filename.substr(-3) === ".md");
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
}

async function attemptCacheReadFiles() {
  const key = "text-paths";
  let texts = await asyncCacheSmembers(key);
  if (!texts || texts.length === 0) {
    console.log("read dir from disk");
    texts = await readFiles();
    texts.forEach(path => {
      cache.sadd(key, path);
    });
  }
  return texts;
}

const server = (options = { routes: {} }) => {
  const { namespace, routes, templateFunction } = options;
  return micro(async (req, res) => {
    const [path, search] = req.url.split("?");
    const [, endpoint] = path.split(routesRegExp());
    // Bail if this isn't a desired endpoint
    if (!endpoint) {
      return notFound(res);
    }
    // Check if the path matches a route from the config
    if (routes[endpoint.substr(1)]) {
      const keys = Object.keys(routes);
      const { string, handler } = routes[endpoint.substr(1)];
      if (string) {
        return ok({ res, path, string });
      }
      if (handler) {
        return ok({ res, path, string: await handler() });
      }
    } else {
      // Else read the texts.
      let texts = await attemptCacheReadFiles();
      const match = texts.indexOf(`${endpoint.substr(1)}.md`);
      if (match === -1) {
        return notFound(res);
      }
      return ok({
        filepath: `${textsDir}/${texts[match]}`,
        path,
        res
      });
    }
  });
};

module.exports = server;
