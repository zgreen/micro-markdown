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
const namespace = `/api/v1`;
const routes = {
  raw: `${namespace}/raw`,
  json: `${namespace}/json`,
  html: `${namespace}/html`
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
    Object.keys(routes)
      .map(keys => routes[keys])
      .join("|")
  );
}

function template(
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

async function attemptCacheGet(filepath, fallback) {
  let text = await asyncCacheGet(filepath);
  if (!text) {
    console.log("read file from disk");
    text = await fallback(filepath);
    asyncCacheSet(filepath, text);
  }
  return text;
}

async function ok(filepath, path, res) {
  const text = await attemptCacheGet(filepath, readFile);
  switch (true) {
    case path.indexOf(routes.raw) === 0:
      return text;
    case path.indexOf(routes.json) === 0:
      return {
        body: text,
        title: parseTitle(text)
      };
    case path.indexOf(routes.html) === 0:
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

async function readTexts() {
  try {
    const files = await asyncReadDir(textsDir, "utf8");
    return files.filter(filename => filename.substr(-3) === ".md");
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
}

async function attemptCacheReadTexts() {
  let texts = await asyncCacheSmembers("paths");
  if (!texts || texts.length === 0) {
    console.log("read dir from disk");
    texts = await readTexts();
    texts.forEach(path => {
      cache.sadd("paths", path);
    });
  }
  return texts;
}

const server = micro(async (req, res) => {
  const [path, search] = req.url.split("?");
  const [, endpoint] = path.split(routesRegExp());
  if (!endpoint) {
    return notFound(res);
  }
  const texts = await attemptCacheReadTexts();
  const match = texts.indexOf(`${endpoint.substr(1)}.md`);
  if (match === -1) {
    return notFound(res);
  }
  return ok(`${textsDir}/${texts[match]}`, path, res);
}).listen(3000);
