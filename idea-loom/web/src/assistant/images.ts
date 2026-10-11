// 随问题附上的图：他选的、贴的、拖进来的，或者当前页面的截屏。发出去之前缩到模型用得上的大小。
// Images sent with a question: chosen, pasted or dropped in, or a capture of the current page.
// They are scaled down to what the model can use before being sent.

export type Attached = { media_type: string; data: string; name: string; url: string }

export const MAX_IMAGES = 4
const MAX_SIDE = 1568 // 再大模型也是先缩小再看 / the model scales anything larger down anyway
const TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif']

function encode(canvas: HTMLCanvasElement, name: string, photo: boolean): Attached {
  // 界面截屏用 PNG（文字清楚），照片用 JPEG（小得多）。 / PNG for UI captures (crisp text), JPEG for photographs (far smaller).
  let url = canvas.toDataURL(photo ? 'image/jpeg' : 'image/png', 0.86)
  if (!photo && url.length > 3_500_000) url = canvas.toDataURL('image/jpeg', 0.86)
  const media_type = url.slice(5, url.indexOf(';'))
  return { media_type, data: url.slice(url.indexOf(',') + 1), name, url }
}

function draw(source: CanvasImageSource, width: number, height: number): HTMLCanvasElement {
  const scale = Math.min(1, MAX_SIDE / Math.max(width, height))
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(width * scale))
  canvas.height = Math.max(1, Math.round(height * scale))
  canvas.getContext('2d')!.drawImage(source, 0, 0, canvas.width, canvas.height)
  return canvas
}

export async function fromFile(file: File): Promise<Attached | null> {
  if (!TYPES.includes(file.type)) return null
  const bitmap = await createImageBitmap(file).catch(() => null)
  if (!bitmap) return null
  const out = encode(draw(bitmap, bitmap.width, bitmap.height), file.name || '', file.type === 'image/jpeg')
  bitmap.close()
  return out
}

export const canCapture = () => typeof navigator !== 'undefined' && !!navigator.mediaDevices && 'getDisplayMedia' in navigator.mediaDevices

// 截当前这个标签页：浏览器会问一次要不要共享，同意后只取一帧就停。这样里面嵌的模拟（别的源、WebGPU 画布）也截得到。
// Capture this tab: the browser asks once whether to share it, and after one frame the capture stops.
// This way embedded simulations (other origins, WebGPU canvases) are captured too.
export async function captureTab(name: string): Promise<Attached | null> {
  if (!canCapture()) return null
  let stream: MediaStream
  try {
    stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false, preferCurrentTab: true } as DisplayMediaStreamOptions)
  } catch {
    return null // 他点了取消 / he cancelled
  }
  try {
    const video = document.createElement('video')
    video.srcObject = stream
    video.muted = true
    await video.play()
    await new Promise((resolve) => setTimeout(resolve, 250)) // 等共享提示条收起来 / let the sharing banner settle
    return encode(draw(video, video.videoWidth, video.videoHeight), name, false)
  } finally {
    stream.getTracks().forEach((track) => track.stop())
  }
}

export function imagesIn(items: DataTransferItemList | null | undefined): File[] {
  return [...(items ?? [])].filter((i) => i.kind === 'file' && TYPES.includes(i.type)).map((i) => i.getAsFile()).filter((f): f is File => f !== null)
}
