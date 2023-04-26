const test = require('brittle')
const c = require('compact-encoding')

const RPC = require('.')

test('basic request/response', async t => {
  const rpc1 = new RPC(send1)
  const rpc2 = new RPC(send2)

  rpc1.register(0, {
    request: c.string,
    response: c.string,
    onrequest: data => {
      t.is(data, 'hello')
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

test('parallel request/response', async t => {
  const rpc1 = new RPC(send1)
  const rpc2 = new RPC(send2)

  rpc1.register(0, {
    request: c.uint,
    response: c.uint,
    onrequest: data => data
  })
  const echo = rpc2.register(0, {
    request: c.uint,
    response: c.uint
  })

  const requests = []
  for (let i = 0; i < 10; i++) {
    requests.push(echo.request(i))
  }
  const results = await Promise.all(requests)
  for (let i = 0; i < results.length; i++) {
    t.is(results[i], i)
  }

  function send1 (data) {
    rpc2.recv(data)
  }
  function send2 (data) {
    rpc1.recv(data)
  }
})

test('batched request/response', async t => {
  const rpc1 = new RPC(send1)
  const rpc2 = new RPC(send2)

  rpc1.register(0, {
    request: c.uint,
    response: c.uint,
    onrequest: data => data
  })
  const echo = rpc2.register(0, {
    request: c.uint,
    response: c.uint
  })
  rpc2.cork()

  let send2Called = false

  const requests = []
  for (let i = 0; i < 10; i++) {
    requests.push(echo.request(i))
  }

  // send2 should not be called until rpc2 is uncorked
  t.is(send2Called, false)

  rpc2.uncork()
  const results = await Promise.all(requests)
  for (let i = 0; i < results.length; i++) {
    t.is(results[i], i)
  }

  function send1 (data) {
    rpc2.recv(data)
  }
  function send2 (data) {
    send2Called = true
    rpc1.recv(data)
  }
})

test('send does not get responses', async t => {
  const rpc1 = new RPC(send1)
  const rpc2 = new RPC(send2)

  const expected = [3, 2, 1]

  rpc1.register(0, {
    request: c.uint,
    response: c.uint,
    onrequest: data => {
      t.is(data, expected.pop())
    }
  })
  const ping = rpc2.register(0, {
    request: c.uint,
    response: c.uint
  })

  ping.send(1)
  ping.send(2)
  ping.send(3)

  t.is(expected.length, 0)

  function send1 (data) {
    rpc2.recv(data)
  }
  function send2 (data) {
    rpc1.recv(data)
  }
})

test('basic bidirectional stream', async t => {
  t.plan(6)
  const rpc1 = new RPC(send1)
  const rpc2 = new RPC(send2)

  const expected = [1, 2, 2, 3]

  rpc1.register(0, {
    request: c.uint,
    response: c.uint,
    onstream: stream => {
      stream.on('data', data => {
        stream.write(data)
        stream.write(data + 1)
      })
      stream.once('end', () => {
        t.pass('remote stream ended')
        stream.end()
      })
    }
  })
  const ping = rpc2.register(0, {
    request: c.uint,
    response: c.uint
  })

  const s = ping.createRequestStream()
  s.write(1)
  s.write(2)
  s.end()

  s.on('data', data => {
    t.is(data, expected.shift())
  })
  s.on('end', () => {
    t.is(expected.length, 0)
  })

  function send1 (data) {
    rpc2.recv(data)
  }
  function send2 (data) {
    rpc1.recv(data)
  }
})
