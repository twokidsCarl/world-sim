// WAV 读写在 src/voice/wav.ts（运行时解码录音包也要用），这里只是转出口。
// The WAV reader/writer lives in src/voice/wav.ts (the run time needs it to decode the sound pack); this file re-exports it.
export { decodeWav, encodeWav, type Wav } from '../../src/voice/wav.ts'
