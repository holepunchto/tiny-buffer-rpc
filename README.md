# tiny-buffer-rpc
Lightweight binary bi-directional RPC.

### Installation
```
npm i tiny-buffer-rpc
```
  
### Usage
```js
const RPC = require('tiny-buffer-rpc')  
const c = require('compact-encoding')

const rpc1 = new RPC(send1)
const rpc2 = new RPC(send2)

rpc1.register(0, {
  request: c.string,
  response: c.string,
  onrequest: data => 'world'
})
const ping = rpc2.register(0, {
  request: c.string,
  response: c.string
})

await ping.request('hello') // 'world'

function send1 (data) {
  rpc2.recv(data)
}
function send2 (data) {
  rpc1.recv(data)
}
```

### API

#### `const rpc = new RPC(send)`
Construct a new `TinyBufferRPC` instance.

`send` must be a function that takes a `Buffer`, and should handle forwarding requests
between the two sides.

#### `const method = rpc.register(id, opts)`
Register a new RPC method for the given `id`

`id` must be an `Integer` >= 0.

If `onrequest` is provided, this method will be able to handle requests.

The return value of `onrequest` will be encoded with the response encoding, then sent.

If `onrequest` throws, the error will be forwarded back to the requester.

`opts` should include:
```js
{
  request: c.buffer, // The request encoding
  response: c.buffer, // The response encoding
  onrequest: data => { ... } // A request handler
}
```

#### `const response = await method.request(data)`
Send a request.

`data` will be encoded with the request encoding.

#### `method.send(data)`
Unidirectionally send data without expecting a response.

Useful for sending events.

`data` will be encoded with the request encoding.
