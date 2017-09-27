const axios = require("axios");
const server = require("./index");
server({
  routeMaps: {
    default: (route, endpoint) => `/${endpoint}`
  },
  routes: {
    home: {
      handler: () => {
        console.log("in the handler");
        return new Promise(resolve => {
          const p1 = axios.get(
            "http://localhost:3000/mm/api/v1/json/more-please"
          );
          const p2 = axios.get("http://localhost:3000/mm/api/v1/json/test");
          Promise.all([p1, p2]).then(result => {
            console.log(result[1].data.body);
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
          });
        });
      }
    },
    test: { string: `# hi, this is a test` },
    "more-please": { string: "# hi, this works, too." }
  }
}).listen(3000);
