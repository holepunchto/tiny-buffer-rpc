const { getStreamError, Duplex } = require('streamx')
const c = require('compact-encoding')
const safetyCatch = require('safety-catch')
const b4a = require('b4a')

// Primary message flags (4 bits)
const MESSAGE_SEND = 0b0001
const MESSAGE_REQUEST = 0b0010
const MESSAGE_RESPONSE = 0b0100
const MESSAGE_ERROR = 0b1000

// Stream message flags (6 bits, with a 4 bit offset for primary message flags)
const STREAMING_MASK = ((1 << 6) - 1) << 4
const STREAM_OPEN = 0b000001 << 4
const STREAM_CLOSE = 0b000010 << 4
const STREAM_PAUSE = 0b000100 << 4
const STREAM_RESUME = 0b001000 << 4
const STREAM_DATA = 0b010000 << 4
const STREAM_END = 0b100000 << 4

// Stream status flags (2 bits, with a 10 bit offset)
const STREAM_IS_INITIATOR = 0b01 << 10
const STREAM_HAS_ERROR = 0b10 << 10

const REQUEST = MESSAGE_SEND | MESSAGE_REQUEST

const {
  Header,
  Message,
  ErrorMessage
} = require('./messages.js')

class Request {
  constructor (method, id, type, data) {
    this.type = type
    this.id = id
    this.method = method
    this.sent = false
    this.data = data
  }

  _respond (data) {
    if (this.sent) throw new Error('Response already sent')
    this.sent = true
    this.method._rpc._sendMessage({
      bitfield: MESSAGE_RESPONSE,
      id: this.id,
      method: this.method._method,
      data: c.encode(this.method._response, data)
    })
  }

  _error (err) {
    if (this.sent) throw new Error('Response already sent')
    this.sent = true
    this.method._rpc._sendMessage({
      bitfield: MESSAGE_ERROR,
      id: this.id,
      method: this.method._method,
      data: c.encode(ErrorMessage, err)
    })
  }
}

class RPCStream extends Duplex {
  constructor (method, id, initiator, remoteId, dedup) {
    super({ eagerOpen: true })

    this._method = method
    this._initiator = initiator

    this._localId = id
    this._remoteId = remoteId
    this._dedup = dedup
    this._lastMessage = null

    this._remotePaused = true
    this._sentPause = false
    this._sentOpen = false
    this._initiatedDestroy = false

    this._writeBatch = null
    this._writeCallback = null
    this._openCallback = null
  }

  _sendBatch (batch) {
    const bitfield = MESSAGE_SEND | STREAM_DATA
    const dataEncoding = this._initiator ? this._method._responseArray : this._method._requestArray
    const data = c.encode(dataEncoding, batch)

    if (this._dedup) {
      if (this._lastMessage && b4a.equals(this._lastMessage, data)) return
      this._lastMessage = data
    }

    this._method._sendMessage(this._remoteId, bitfield, data)
  }

  _remoteOpened (remoteId) {
    this._remoteId = remoteId
    this._continueOpen(null)
  }

  _remoteClosed (err) {
    this._remoteId = -1
    this.destroy(err)
  }

  _remotePause () {
    this._remotePaused = true
  }

  _remoteResume () {
    this._remotePaused = false
    if (!this._writeBatch) return

    this._sendBatch(this._writeBatch)
    this._writeBatch = null
    this._continueWrite(null)
  }

  _sendOpen () {
    if (this._sentOpen) return

    let bitfield = MESSAGE_SEND | STREAM_OPEN
    if (this._initiator) bitfield |= STREAM_IS_INITIATOR

    const id = this._initiator ? this._localId : this._remoteId
    const data = this._initiator ? null : c.encode(c.uint, this._localId)

    this._sentOpen = true
    this._method._sendMessage(id, bitfield, data)
  }

  _open (cb) {
    this._sendOpen()

    if (this._initiator) {
      this._openCallback = cb
    } else {
      cb()
    }
  }

  _continueOpen (err) {
    if (this._openCallback === null) return
    const cb = this._openCallback
    this._openCallback = null
    cb(err)
  }

  _read (cb) {
    this._method._sendMessage(this._remoteId, MESSAGE_SEND | STREAM_RESUME)
    cb()
  }

  _writev (batch, cb) {
    if (this._remotePaused) {
      this._writeBatch = batch
      this._writeCallback = cb
    } else {
      this._sendBatch(batch)
      cb()
    }
  }

  _continueWrite (err) {
    if (this._writeCallback === null) return
    const cb = this._writeCallback
    this._writeCallback = null
    cb(err)
  }

  _final (cb) {
    this._method._sendMessage(this._remoteId, MESSAGE_SEND | STREAM_END)
    cb()
  }

  _predestroy () {
    this._initiatedDestroy = true
    this._continueWrite(null)
  }

  _destroy (cb) {
    if (this._remoteId === -1 || this._initiatedDestroy === false || this._method.destroyed) {
      // if the remote side already sent a close or we are the initiator and we didn't open,
      // then we don't need to send a close message
      cb()
      return
    }

    const err = getStreamError(this)

    let bitfield = MESSAGE_SEND | STREAM_CLOSE
    if (err) bitfield |= STREAM_HAS_ERROR
    const data = err ? c.encode(ErrorMessage, err) : null

    this._method._sendMessage(this._remoteId, bitfield, data)
    cb()
  }
}

class Method {
  constructor (rpc, method, { request, response, dedup = false, onrequest, onstream } = {}) {
    this.destroyed = false

    this._rpc = rpc
    this._method = method

    this._request = request || c.buffer
    this._response = response || c.buffer
    this._requestArray = c.array(this._request)
    this._responseArray = c.array(this._response)

    this._dedup = dedup
    this._onrequest = onrequest
    this._onstream = onstream

    this._streams = []
    this._free = []
  }

  async _callOnRequest (req) {
    try {
      const data = await this._onrequest(req.data)
      req._respond(data)
    } catch (err) {
      req._error(err)
    }
  }

  async _callOnSend (data) {
    try {
      await this._onrequest(data)
    } catch (err) {
      safetyCatch(err)
    }
  }

  _createStream (initiator, remoteId) {
    const id = this._free.length ? this._free.pop() : (this._streams.push(null) - 1)
    const stream = new RPCStream(this, id, initiator, remoteId, this._dedup)
    this._streams[id] = stream
    return stream
  }

  _handleStreamOpen (id, bitfield, state) {
    if (bitfield & STREAM_IS_INITIATOR) {
      // Create the responder stream
      const stream = this._createStream(false, id)
      this._onstream(stream)
    } else {
      const stream = this._streams[id]
      stream._remoteOpened(c.uint.decode(state))
    }
  }

  _handleStreamClose (id, bitfield, state) {
    const stream = this._streams[id]
    if (bitfield & STREAM_HAS_ERROR) {
      const err = ErrorMessage.decode(state)
      stream._remoteClosed(err)
    } else {
      stream._remoteClosed(null)
    }
    this._streams[id] = null
    this._free.push(id)
  }

  _handleStreamPause (id) {
    const stream = this._streams[id]
    if (stream) stream._remotePause()
  }

  _handleStreamResume (id) {
    const stream = this._streams[id]
    if (stream) stream._remoteResume()
  }

  _handleStreamEnd (id) {
    const stream = this._streams[id]
    if (stream) stream.push(null)
  }

  _handleStreamData (id, state) {
    const stream = this._streams[id]
    if (!stream) return

    let data = null
    if (stream._initiator) {
      data = this._responseArray.decode(state)
    } else {
      data = this._requestArray.decode(state)
    }

    // TODO: Should we buffer the remainder of the array?
    let stop = false
    for (const item of data) {
      stop = stream.push(item)
    }

    if (stop === false) {
      if (!stream._sentPause) {
        stream._sentPause = true
        this._sendMessage(stream._remoteId, MESSAGE_SEND | STREAM_PAUSE)
      }
    }
  }

  _handleStreamSend (id, bitfield, state) {
    if (bitfield & STREAM_OPEN) {
      this._handleStreamOpen(id, bitfield, state)
    } else if (bitfield & STREAM_CLOSE) {
      this._handleStreamClose(id, bitfield, state)
    } else if (bitfield & STREAM_PAUSE) {
      this._handleStreamPause(id)
    } else if (bitfield & STREAM_RESUME) {
      this._handleStreamResume(id)
    } else if (bitfield & STREAM_DATA) {
      this._handleStreamData(id, state)
    } else if (bitfield & STREAM_END) {
      this._handleStreamEnd(id)
    }
  }

  _handleSend (id, bitfield, state) {
    if (bitfield & STREAMING_MASK) {
      this._handleStreamSend(id, bitfield, state)
    } else {
      this._callOnSend(this._request.decode(state))
    }
  }

  _handleRequest (id, bitfield, state) {
    if (this.destroyed) return
    if (bitfield & MESSAGE_SEND) {
      this._handleSend(id, bitfield, state)
    } else {
      const req = new Request(this, id, bitfield, this._request.decode(state))
      this._callOnRequest(req)
    }
  }

  _handleResponse (req, bitfield, state) {
    if (this.destroyed) return
    if (bitfield & MESSAGE_ERROR) {
      const { errno, message, stack, code } = ErrorMessage.decode(state)
      const err = new Error()
      err.errno = errno
      err.message = message
      err.stack = stack
      err.code = code
      req.reject(err)
    } else {
      req.resolve(this._response.decode(state))
    }
    this._rpc._reqs[req.id] = null
    this._rpc._free.push(req.id)
  }

  _sendMessage (id, bitfield, data) {
    this._rpc._sendMessage({
      method: this._method,
      bitfield,
      id,
      data
    })
  }

  request (data) {
    if (this.destroyed) return Promise.reject(new Error('RPC destroyed'))
    const req = this._rpc._createRequest()
    this._sendMessage(req.id, MESSAGE_REQUEST, c.encode(this._request, data))
    return req.promise
  }

  send (data) {
    if (this.destroyed) return
    this._sendMessage(0, MESSAGE_SEND, c.encode(this._request, data))
  }

  createRequestStream () {
    if (this.destroyed) throw new Error('RPC destroyed')
    return this._createStream(true, -1)
  }

  destroy () {
    this.destroyed = true
    for (const s of this._streams) {
      if (s === null) continue
      s.destroy(new Error('RPC destroyed'))
    }
  }
}

module.exports = class TinyBufferRPC {
  constructor (send) {
    this.destroyed = false
    this._send = send
    this._handlers = []
    this._pending = []
    this._reqs = []
    this._free = []
    this._corked = false
  }

  _createRequest () {
    const id = this._free.length ? this._free.pop() : (this._reqs.push(null) - 1)
    const req = { id, promise: null, resolve: null, reject: null }
    this._reqs[id] = req
    req.promise = new Promise((resolve, reject) => {
      req.resolve = resolve
      req.reject = reject
    })
    return req
  }

  _sendMessage (msg) {
    if (this.destroyed) return
    const data = c.encode(Message, msg)
    if (this._corked) {
      this._pending.push(data)
      return
    }
    this._send(data)
  }

  register (id, opts = {}) {
    if (this._handlers[id]) throw new Error('Handler for this ID already exists')
    while (this._handlers.length <= id) this._handlers.push(null)
    const method = new Method(this, id, opts)
    this._handlers[id] = method
    return method
  }

  cork () {
    this._corked = true
  }

  uncork () {
    this._corked = false
    // TODO: Use a slab pattern here to avoid the concat
    if (!this.destroyed) this._send(b4a.concat(this._pending))
    this._pending = []
  }

  recv (buf) {
    const state = { start: 0, end: buf.length, buffer: buf }
    while (state.start < state.end) {
      const { id, bitfield, method } = Header.decode(state)
      if (bitfield & REQUEST) {
        const handler = this._handlers[method]
        if (!handler) throw new Error('Got a request for an unsupported method')
        else handler._handleRequest(id, bitfield, state)
      } else {
        const req = this._reqs[id]
        const handler = this._handlers[method]
        if (!req) throw new Error('Got a response for an invalid request ID')
        if (!handler) throw new Error('Got a response for an invalid method ID')
        handler._handleResponse(req, bitfield, state)
      }
    }
  }

  destroy () {
    this.destroyed = true
    while (this._reqs.length) {
      const req = this._reqs.pop()
      if (req === null) continue
      req.reject(new Error('RPC destroyed'))
    }
    for (const h of this._handlers) {
      if (h === null) continue
      h.destroy()
    }
  }
}
