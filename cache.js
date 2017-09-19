const redis = require("redis");
const cache = redis.createClient();

cache.flushall(err => {
  if (!err) {
    cache.quit();
  }
});
