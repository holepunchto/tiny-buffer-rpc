const c = require('compact-encoding')
const b4a = require('b4a')

const { MessageTypes, Header, Message, ErrorMessage } = require('./messages.js')

class Request {
  constructor (method, id, type, data) {
    this._type = type
    this._id = id
    this._method = method
    this._sent = false
    this.data = data
  }

  _respond (data) {
    if (this._sent) throw new Error('Response already sent')
    this._sent = true
    this._method._rpc._sendMessage({
      type: MessageTypes.Response,
      id: this._id,
      method: this._method,
      data: c.encode(this._method._response, data)
    })
  }

  _error (err) {
    if (this._sent) throw new Error('Response already sent')
    this._sent = true
    this._method._rpc._sendMessage({
      type: MessageTypes.Error,
      id: this._id,
      method: this._method,
      data: c.encode(ErrorMessage, err)
    })
  }
}

class Method {
  constructor (rpc, method, { request, response, onrequest } = {}) {
    this._rpc = rpc
    this._method = method
    this._request = request || c.buffer
    this._response = response || c.buffer
    this._onrequest = onrequest
  }

  async _callOnRequest (req) {
    try {
      const data = await this._onrequest(req)
      req._respond(data)
    } catch (err) {
      req._error(err)
    }
  }

  _handleRequest (id, type, state) {
    if (!this._onrequest) throw new Error('Got a request for a method without an onrequest handler')
    const req = new Request(this, id, type, this._request.decode(state))
    this._callOnRequest(req)
  }

  _handleResponse (req, type, state) {
    if (type === MessageTypes.Error) {
      const { code, message, stack } = ErrorMessage.decode(state)
      const err = new Error()
      err.code = code
      err.message = message
      err.stack = stack
      req.reject(err)
    } else {
      req.resolve(this._response.decode(state))
    }
    this._rpc._free.push(req.id)
  }

  request (data) {
    const req = this._rpc._req()
    this._rpc._sendMessage({
      id: req.id,
      type: MessageTypes.Request,
      method: this._method,
      data: c.encode(this._request, data)
    })
    return req.promise
  }
}

module.exports = class TinyBufferRPC {
  constructor (send) {
    this._send = send
    this._handlers = []
    this._pending = []
    this._reqs = []
    this._free = []
    this._corked = false
  }

  _req () {
    const id = this._free.length ? this._free.pop() : this._reqs.push(null)
    const req = { id, promise: null, resolve: null, reject: null }
    this._reqs[id] = req
    req.promise = new Promise((resolve, reject) => {
      req.resolve = resolve
      req.reject = reject
    })
    return req
  }

  _sendMessage (msg) {
    const data = c.encode(Message, msg)
    if (this._corked) {
      this._pending.push(data)
      return
    }
    this._send(data)
  }

  register (id, opts) {
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
    this._send(b4a.concat(this._pending))
    this._pending = []
  }

  recv (buf) {
    const state = { start: 0, end: buf.length, buffer: buf }
    while (state.start < state.end) {
      const { id, type, method } = Header.decode(state)
      if (type === MessageTypes.Request) {
        const handler = this._handlers[method]
        if (!handler) throw new Error('Got a request for an unsupported method')
        else handler._handleRequest(id, type, state)
      } else {
        const req = this._reqs[id]
        const handler = this._handlers[method]
        if (!req) throw new Error('Got a response for an invalid request ID')
        if (!handler) throw new Error('Got a response for an invalid method ID')
        handler._handleResponse(req, type, state)
      }
    }
  }
}
