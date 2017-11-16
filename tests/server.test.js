/* globals expect test */
const mm = require('../index')
const axios = require('axios')
let server

afterEach(() => {
  server.close()
})

test('The server listens.', done => {
  server = mm()
  server.on('listening', () => {
    expect.anything()
    done()
  })
  server.listen(3000)
})

test('A custom title.', done => {
  server = mm({
    title: 'foo'
    // routes: { foo: { handler: () => ({ html: '' }) } }
  })
  server.on('listening', () => {
    axios
      .get('http://localhost:3000/')
      .catch(err => {
        console.error(err)
      })
      .then(resp => {
        console.log('resp is', resp)
        done()
      })
  })
  server.listen(3000)
})
