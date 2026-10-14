// 区分触控板的双指滑动和鼠标滚轮 / Telling a two-finger trackpad swipe from a mouse wheel.
//
// 浏览器没有直接的标志，这里用通行的经验判断：
// - 横向分量不为 0：触控板（或按住 Shift 的滚轮，同样当作平移）；
// - Chrome / Safari 给出旧的 wheelDeltaY：触控板时它恰好是 −3 × deltaY，鼠标滚轮时是 120 的倍数，对不上；
// - 没有 wheelDeltaY（Firefox）：触控板按像素（deltaMode 0），鼠标滚轮按行（deltaMode 1）。
// 判断错了的后果只是这一下滚动变成缩放或平移，不会丢数据。
// Browsers give no direct flag, so this uses the common heuristic:
// - a non-zero horizontal component: a trackpad (or a wheel with Shift held, also taken as a pan);
// - Chrome / Safari report the legacy wheelDeltaY: for a trackpad it is exactly −3 × deltaY, for a mouse wheel a multiple
//   of 120 that does not match;
// - without wheelDeltaY (Firefox): a trackpad scrolls in pixels (deltaMode 0), a mouse wheel in lines (deltaMode 1).
// A wrong guess only turns this one scroll into a zoom or a pan; nothing is lost.

/** 轮事件里判断要用到的字段 / The fields of a wheel event the test needs. */
export interface WheelLike {
  deltaX: number
  deltaY: number
  deltaMode: number
  wheelDeltaY?: number
}

/** 这一下滚动是否来自触控板的双指滑动 / Whether this scroll comes from a two-finger trackpad swipe. */
export function isTrackpadScroll(e: WheelLike): boolean {
  if (e.deltaMode !== 0) return false
  if (e.deltaX !== 0) return true
  const legacy = e.wheelDeltaY
  if (typeof legacy === 'number' && legacy !== 0) return legacy === -3 * e.deltaY
  return true
}
