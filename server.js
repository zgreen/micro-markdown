const axios = require("axios");
const server = require("./index");
server({
  // cacheClient: () => true,
  routeMaps: {
    default: route => {
      return route.indexOf("/mm") === 0
        ? {}
        : { route: `${route}`, target: "html" };
    }
  },
  routes: {
    "no-promise": {
      handler: () => 1 + 1
    },
    home: {
      handler: () => {
        return new Promise((resolve, reject) => {
          const p1 = axios.get(
            "http://localhost:3000/mm/api/v1/json/more-please"
          );
          const p2 = axios.get("http://localhost:3000/mm/api/v1/json/test");
          Promise.all([p1, p2]).then(
            result => {
              resolve(`<h1>This is a blog.</h1>

<h2>These are some posts</h2>
<ul>
  ${result
    .map(resp => {
      const { body } = resp.data;
      return `${body}`;
    })
    .join("\n")}
</ul>
${result[0].data.body}
${result[1].data.body}`);
            },
            reason => {
              reject(reason);
            }
          );
        });
      }
    },
    test: { string: `# hi, this is a test` },
    "more-please": { string: "# hi, this works, too." }
  }
}).listen(3000);
