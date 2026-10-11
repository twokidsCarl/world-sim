// WAV 读写：只支持本工具需要的 PCM 16/24/32 位整数与 32 位浮点；多声道读入时取平均。
// WAV read/write: only what this tool needs (PCM 16/24/32-bit integer and 32-bit float); multichannel input is averaged to mono.

export interface Wav {
  sampleRate: number
  samples: Float32Array
}

export function decodeWav(bytes: Uint8Array): Wav {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const tag = (o: number) => String.fromCharCode(bytes[o]!, bytes[o + 1]!, bytes[o + 2]!, bytes[o + 3]!)
  if (tag(0) !== 'RIFF' || tag(8) !== 'WAVE') throw new Error('not a RIFF/WAVE file')
  let fmt = 1
  let channels = 1
  let sampleRate = 44100
  let bits = 16
  let o = 12
  while (o + 8 <= bytes.length) {
    const id = tag(o)
    const size = dv.getUint32(o + 4, true)
    const body = o + 8
    if (id === 'fmt ') {
      fmt = dv.getUint16(body, true)
      channels = dv.getUint16(body + 2, true)
      sampleRate = dv.getUint32(body + 4, true)
      bits = dv.getUint16(body + 14, true)
      // WAVE_FORMAT_EXTENSIBLE：真正的格式在子格式 GUID 的头两个字节 / the real format is the first two bytes of the sub-format GUID
      if (fmt === 0xfffe && size >= 26) fmt = dv.getUint16(body + 24, true)
    } else if (id === 'data') {
      const bytesPer = bits / 8
      const n = Math.floor(Math.min(size, bytes.length - body) / (bytesPer * channels))
      const out = new Float32Array(n)
      for (let i = 0; i < n; i++) {
        let s = 0
        for (let c = 0; c < channels; c++) {
          const p = body + (i * channels + c) * bytesPer
          if (fmt === 3) s += dv.getFloat32(p, true)
          else if (bits === 16) s += dv.getInt16(p, true) / 32768
          else if (bits === 24) s += ((dv.getInt8(p + 2) << 16) | (dv.getUint8(p + 1) << 8) | dv.getUint8(p)) / 8388608
          else if (bits === 32) s += dv.getInt32(p, true) / 2147483648
          else throw new Error(`unsupported bit depth ${bits}`)
        }
        out[i] = s / channels
      }
      return { sampleRate, samples: out }
    }
    o = body + size + (size & 1)
  }
  throw new Error('no data chunk')
}

// 写 16 位单声道 PCM；超出 ±1 的样本被截断（调用方应保证不会发生）。
// Writes 16-bit mono PCM; samples beyond ±1 are clamped (callers should make sure that never happens).
export function encodeWav(samples: Float32Array, sampleRate: number): Uint8Array {
  const out = new Uint8Array(44 + samples.length * 2)
  const dv = new DataView(out.buffer)
  const put = (o: number, s: string) => { for (let i = 0; i < s.length; i++) out[o + i] = s.charCodeAt(i) }
  put(0, 'RIFF'); dv.setUint32(4, 36 + samples.length * 2, true); put(8, 'WAVE'); put(12, 'fmt ')
  dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true)
  dv.setUint32(24, sampleRate, true); dv.setUint32(28, sampleRate * 2, true); dv.setUint16(32, 2, true); dv.setUint16(34, 16, true)
  put(36, 'data'); dv.setUint32(40, samples.length * 2, true)
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]!))
    dv.setInt16(44 + i * 2, Math.round(s * 32767), true)
  }
  return out
}
