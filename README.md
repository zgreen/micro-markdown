# micro-markdown

> ⚠️ Under active development; not stable. ⚠️

`micro-markdown` is a markdown server. It serves both markdown files and markdown strings. It's built on top of Zeit's `micro`, and uses a redis cache by default. In the spirit of `micro`, `micro-markdown` tries to be as async as possible.

`micro-markdown` can be used as an API for rendering and serving markdown, or as a server for a markdown based website.

## Markdown files

To serve a markdown file, add a file to the `./texts` directory (this path is customizable).

```md
<!-- ./texts/hello.md -->
# Hello, world.

I am some markdown.
```

```js
// ./server.js
const server = require('micro-markdown')
/**
 * Start the server.
 * The rendered HTML will be available at `http://localhost:3000/mm/api/v1/html/hello`
 */
server().listen(3000)
```

## Custom handlers

You can also pass a route handlers directly to `micro-markdown`:

```js
// ./server.js
const server = require('micro-markdown')
/**
 * Start the server.
 * The rendered HTML will be available at `http://localhost:3000/mm/api/v1/html/example`
 */
server({
  routes: {
    'example': {
      handler: () => ({ markdown: '# Hello, example.' })
    }
  }
}).listen(3000)
```

## API

By default, `micro-markdown` renders three endpoints for each route:

- `/mm/api/v1/html/:endpoint`: Returns the rendered HTML for `:endpoint`
- `/mm/api/v1/json/:endpoint`: Returns a JSON object representing the provided markdown for `:endpoint.`
- `/mm/api/v1/raw/:endpoint`: Returns the raw markdown string for `:endpoint`.

## Route maps

You can pass route maps to `micro-markdown` to mirror existing endpoints. This is helpful if you want to use `micro-markdown` to serve a markdown-based website.

```js
// ./server.js
const server = require('micro-markdown')
/**
 * Start the server.
 * The rendered HTML will be available at `http://localhost:3000/example`
 */
server({
  routes: {
    'example': {
      handler: () => ({ markdown: '# Hello, example.' })
    }
  },
  routeMaps: {
    default: route => { // Resolve `/mm/api/v1/html/${foo}` to `/${foo}`
      return route.indexOf("/mm") === 0
        ? {}
        : { route: `${route}`, target: "html" };
    }
  }
}).listen(3000)
```

## Caching

Rendered markup is cached by default, using redis. To use the redis cache, provide the following environment variables:

```
REDIS_HOST="YOUR_REDIS_HOST" # Default `redis`
REDIS_PORT="YOUR_REDIS_PASSWORD" # Default `6379`
# Optional
REDIS_PASSWORD="YOUR_REDIS_PASSWORD"
```

By default, `micro-markdown` will flush the redis cache the first time it is called.
