const mm = require("../index");

test("The server listens.", done => {
  const server = mm();
  server.on("listening", () => {
    expect.anything();
    done();
  });
  server.listen(3000);
});
