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

test('basic request/response at ID > 0', async t => {
  const rpc1 = new RPC(send1)
  const rpc2 = new RPC(send2)

  rpc1.register(1, {
    request: c.string,
    response: c.string,
    onrequest: data => {
      t.is(data, 'hello')
      return 'world'
    }
  })
  const ping = rpc2.register(1, {
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

test('eager teardown of stream', async t => {
  t.plan(2)

  const rpc1 = new RPC(send1)
  const rpc2 = new RPC(send2)

  rpc1.register(0, {
    request: c.uint,
    response: c.uint,
    onstream: stream => {
      t.fail('should never get here')
    }
  })
  const ping = rpc2.register(0, {
    request: c.uint,
    response: c.uint
  })

  const s = ping.createRequestStream()
  s.on('error', function () {
    t.pass('got error')
  })
  s.on('close', function () {
    t.pass('got close')
  })
  s.destroy(new Error('stop'))

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

test('multiple parallel bidirectional streams, same method', async t => {
  t.plan(12)
  const rpc1 = new RPC(send1)
  const rpc2 = new RPC(send2)

  const expected1 = [1, 2, 2, 3]
  const expected2 = [3, 4, 4, 5]

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

  const s1 = ping.createRequestStream()
  const s2 = ping.createRequestStream()
  s1.write(1)
  s1.write(2)
  s2.write(3)
  s2.write(4)
  s1.end()
  s2.end()

  s1.on('data', data => {
    t.is(data, expected1.shift())
  })
  s1.on('end', () => {
    t.is(expected1.length, 0)
  })
  s2.on('data', data => {
    t.is(data, expected2.shift())
  })
  s2.on('end', () => {
    t.is(expected2.length, 0)
  })

  function send1 (data) {
    rpc2.recv(data)
  }
  function send2 (data) {
    rpc1.recv(data)
  }
})

test('multiple parallel bidirectional streams, different method', async t => {
  t.plan(12)
  const rpc1 = new RPC(send1)
  const rpc2 = new RPC(send2)

  const expected1 = [1, 2, 2, 3]
  const expected2 = [3, 5, 4, 6]

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
  rpc1.register(1, {
    request: c.uint,
    response: c.uint,
    onstream: stream => {
      stream.on('data', data => {
        stream.write(data)
        stream.write(data + 2)
      })
      stream.once('end', () => {
        t.pass('remote stream ended')
        stream.end()
      })
    }
  })
  const ping1 = rpc2.register(0, {
    request: c.uint,
    response: c.uint
  })
  const ping2 = rpc2.register(1, {
    request: c.uint,
    response: c.uint
  })

  const s1 = ping1.createRequestStream()
  const s2 = ping2.createRequestStream()
  s1.write(1)
  s1.write(2)
  s2.write(3)
  s2.write(4)
  s1.end()
  s2.end()

  s1.on('data', data => {
    t.is(data, expected1.shift())
  })
  s1.on('end', () => {
    t.is(expected1.length, 0)
  })
  s2.on('data', data => {
    t.is(data, expected2.shift())
  })
  s2.on('end', () => {
    t.is(expected2.length, 0)
  })

  function send1 (data) {
    rpc2.recv(data)
  }
  function send2 (data) {
    rpc1.recv(data)
  }
})

test('basic bidirectional stream, remote destroys', async t => {
  t.plan(2)
  const rpc1 = new RPC(send1)
  const rpc2 = new RPC(send2)

  rpc1.register(0, {
    request: c.uint,
    response: c.uint,
    onstream: stream => {
      stream.on('data', data => {
        stream.destroy()
      })
      stream.on('close', () => {
        t.pass('remote stream closed')
      })
    }
  })
  const ping = rpc2.register(0, {
    request: c.uint,
    response: c.uint
  })

  const s = ping.createRequestStream()
  s.write(1)
  s.on('close', () => {
    t.pass('stream closed')
  })

  function send1 (data) {
    rpc2.recv(data)
  }
  function send2 (data) {
    rpc1.recv(data)
  }
})

test('basic bidirectional stream, initator destroys', async t => {
  t.plan(2)
  const rpc1 = new RPC(send1)
  const rpc2 = new RPC(send2)

  rpc1.register(0, {
    request: c.uint,
    response: c.uint,
    onstream: stream => {
      stream.write(1)
      stream.on('close', () => {
        t.pass('remote stream closed')
      })
    }
  })
  const ping = rpc2.register(0, {
    request: c.uint,
    response: c.uint
  })

  const s = ping.createRequestStream()
  s.on('data', data => {
    s.destroy()
  })
  s.on('close', () => {
    t.pass('stream closed')
  })

  function send1 (data) {
    rpc2.recv(data)
  }
  function send2 (data) {
    rpc1.recv(data)
  }
})

test('dedup bidirectional stream', async t => {
  t.plan(4)
  const rpc1 = new RPC(send1)
  const rpc2 = new RPC(send2)

  const expected = [1, 2]

  rpc1.register(0, {
    request: c.uint,
    response: c.uint,
    onstream: stream => {
      stream.on('data', data => {
        stream.write(data)
      })
      stream.once('end', () => {
        t.pass('remote stream ended')
        stream.end()
      })
    }
  })
  const ping = rpc2.register(0, {
    dedup: true,
    request: c.uint,
    response: c.uint
  })

  const s = ping.createRequestStream()
  s.write(1)
  await new Promise(resolve => setTimeout(resolve, 100))
  s.write(1)
  await new Promise(resolve => setTimeout(resolve, 100))
  s.write(1)
  await new Promise(resolve => setTimeout(resolve, 100))
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
