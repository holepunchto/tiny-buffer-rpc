// This file is a tmp workaround until variadic args land in tiny-buffer-rpc

const b4a = require('b4a')
const c = require('compact-encoding')
const { uint, utf8 } = c

const anyUndefined = {
  preencode (state, n) {
    // do nothing
  },
  encode (state, n) {
    // do nothing
  },
  decode (state) {
    return undefined
  }
}

// "any" encoders here for helping just structure any object without schematising it

const anyArray = {
  preencode (state, arr) {
    uint.preencode(state, arr.length)
    for (let i = 0; i < arr.length; i++) {
      any.preencode(state, arr[i])
    }
  },
  encode (state, arr) {
    uint.encode(state, arr.length)
    for (let i = 0; i < arr.length; i++) {
      any.encode(state, arr[i])
    }
  },
  decode (state) {
    const arr = []
    let len = uint.decode(state)
    while (len-- > 0) {
      arr.push(any.decode(state))
    }
    return arr
  }
}

const anyObject = {
  preencode (state, o) {
    const keys = Object.keys(o)
    uint.preencode(state, keys.length)
    for (const key of keys) {
      utf8.preencode(state, key)
      any.preencode(state, o[key])
    }
  },
  encode (state, o) {
    const keys = Object.keys(o)
    uint.encode(state, keys.length)
    for (const key of keys) {
      utf8.encode(state, key)
      any.encode(state, o[key])
    }
  },
  decode (state) {
    let len = uint.decode(state)
    const o = {}
    while (len-- > 0) {
      const key = utf8.decode(state)
      o[key] = any.decode(state)
    }
    return o
  }
}

const anyTypes = [
  c.none,
  anyUndefined,
  c.bool,
  c.string,
  c.buffer,
  c.uint,
  c.int,
  c.float64,
  anyArray,
  anyObject
]

const any = module.exports = {
  preencode (state, o) {
    const t = getType(o)
    uint.preencode(state, t)
    anyTypes[t].preencode(state, o)
  },
  encode (state, o) {
    const t = getType(o)
    uint.encode(state, t)
    anyTypes[t].encode(state, o)
  },
  decode (state) {
    const t = uint.decode(state)
    if (t >= anyTypes.length) throw new Error('Unknown type: ' + t)
    return anyTypes[t].decode(state)
  }
}

function getType (o) {
  if (o === null) return 0
  if (o === undefined) return 1
  if (typeof o === 'boolean') return 2
  if (typeof o === 'string') return 3
  if (b4a.isBuffer(o)) return 4
  if (typeof o === 'number') {
    if (Number.isInteger(o)) return o >= 0 ? 5 : 6
    return 7
  }
  if (Array.isArray(o)) return 8
  if (typeof o === 'object') return 9

  throw new Error('Unsupported type for ' + o)
}
