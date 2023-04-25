const test = require('brittle')
const c = require('compact-encoding')

const RPC = require('.')

test('basic request/response', async t => {
  const rpc1 = new RPC(send1)
  const rpc2 = new RPC(send2)

  rpc1.register(0, {
    request: c.string,
    response: c.string,
    onrequest: req => {
      t.is(req.data, 'hello')
      return 'world'
    }
  })
  const ping = rpc2.register(0, {
    request: c.string,
    response: c.string
  })

  t.is(await ping.request('hello'), 'world')

  function send1 (data) {
    rpc2.recv(data)
  }
  function send2 (data) {
    rpc1.recv(data)
  }
})
