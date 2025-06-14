const c = require('compact-encoding')

const KNOWN_BYTE = 0x74 // 't' for tiny-buffer-rpc

const Header = {
  preencode (state, h) {
    c.uint.preencode(state, KNOWN_BYTE)
    c.uint.preencode(state, h.method)
    c.uint.preencode(state, h.id)
    c.uint.preencode(state, h.bitfield)
  },
  encode (state, h) {
    c.uint.encode(state, KNOWN_BYTE)
    c.uint.encode(state, h.method)
    c.uint.encode(state, h.id)
    c.uint.encode(state, h.bitfield)
  },
  decode (state) {
    const known = c.uint.decode(state)
    if (known !== KNOWN_BYTE) throw Error('Message at start = ' + state.start + ' end = ' + state.end + ' does not look like a TinyRPC message')

    return {
      method: c.uint.decode(state),
      id: c.uint.decode(state),
      bitfield: c.uint.decode(state)
    }
  }
}
module.exports.Header = Header

module.exports.Message = {
  preencode (state, m) {
    Header.preencode(state, m)
    if (m.data) c.raw.preencode(state, m.data)
  },
  encode (state, m) {
    Header.encode(state, m)
    if (m.data) c.raw.encode(state, m.data)
  },
  decode (state) {
    return {
      ...Header.decode(state),
      data: c.raw.decode(state)
    }
  }
}

module.exports.ErrorMessage = {
  preencode (state, e) {
    state.end++ // flags
    c.int.preencode(state, e.errno || 0)
    if (e.message) c.string.preencode(state, e.message)
    if (e.stack) c.string.preencode(state, e.stack)
    if (e.code) c.string.preencode(state, e.code)
  },
  encode (state, e) {
    const start = state.start++ // flags
    c.int.encode(state, e.errno || 0)

    let flags = 0
    if (e.message) {
      flags |= 1
      c.string.encode(state, e.message)
    }
    if (e.stack) {
      flags |= 2
      c.string.encode(state, e.stack)
    }
    if (e.code) {
      flags |= 4
      c.string.encode(state, e.code)
    }

    state.buffer[start] = flags
  },
  decode (state) {
    const flags = c.uint.decode(state)
    return {
      errno: c.int.decode(state),
      message: (flags & 1) !== 0 ? c.string.decode(state) : null,
      stack: (flags & 2) !== 0 ? c.string.decode(state) : null,
      code: (flags & 4) !== 0 ? c.string.decode(state) : null
    }
  }
}
