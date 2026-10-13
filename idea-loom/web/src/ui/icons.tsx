import type { ReactNode } from 'react'

// 界面里用的小图标：自己画的内联 SVG，24 格、只描边、颜色跟着文字（currentColor），不引图标库。
// The small icons of the UI: inline SVG drawn for this project, on a 24 grid, stroke only, coloured by the text (currentColor), with no icon library.
const SHAPES = {
  // 无尽探索：指南针 / Explore: a compass
  compass: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M15.5 8.5l-2 5-5 2 2-5z" />
    </>
  ),
  // 想法：灯泡 / Ideas: a light bulb
  bulb: <path d="M9 18h6M10 21h4M12 3a6 6 0 0 0-4 10.5c.7.7 1 1.5 1 2.5h6c0-1 .3-1.8 1-2.5A6 6 0 0 0 12 3z" />,
  // 开发：一条分支并回主干 / Work: a branch joining the trunk
  branch: (
    <>
      <circle cx="6" cy="5" r="2" />
      <circle cx="6" cy="19" r="2" />
      <circle cx="18" cy="7" r="2" />
      <path d="M6 7v10M18 9c0 5-12 2-12 8" />
    </>
  ),
  // 许愿池：星 / Wish pool: a star
  star: <path d="M12 3l2.6 6 6.4.6-4.8 4.3 1.4 6.4L12 17l-5.6 3.3 1.4-6.4L3 9.6 9.4 9z" />,
  // 自我进化：终端提示符 / Self-evolution: a terminal prompt
  terminal: (
    <>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M7 9l3 3-3 3M13 15h4" />
    </>
  ),
  // 统计：柱状图 / Statistics: a bar chart
  bars: <path d="M4 20h16M7 20v-7M12 20V6M17 20V10" />,
  plus: <path d="M12 5v14M5 12h14" />,
  // 同步到仓库：向上推 / Sync to the repository: push upwards
  upload: <path d="M12 16V5M7 10l5-5 5 5M5 19h14" />,
  // 正在同步：三个点 / Syncing: three dots
  dots: <path d="M6 12h.01M12 12h.01M18 12h.01" strokeWidth="2.6" />,
  login: <path d="M10 4h8a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1h-8M4 12h10M10 8l4 4-4 4" />,
  logout: <path d="M14 4H6a1 1 0 0 0-1 1v14a1 1 0 0 0 1 1h8M10 12h10M16 8l4 4-4 4" />,
  bell: <path d="M6 16v-5a6 6 0 0 1 12 0v5l1.5 2h-15zM10 21h4" />,
  bellOff: <path d="M6 16v-5a6 6 0 0 1 12 0v5l1.5 2h-15zM10 21h4M4 4l16 16" />,
  sun: (
    <>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
    </>
  ),
  moon: <path d="M20 14.5A8 8 0 0 1 9.5 4 8 8 0 1 0 20 14.5z" />,
  chevronsLeft: <path d="M11 7l-5 5 5 5M18 7l-5 5 5 5" />,
  chevronsRight: <path d="M13 7l5 5-5 5M6 7l5 5-5 5" />,
  // 产品的记号：经线和纬线 / The product mark: warp and weft
  loom: <path d="M6 3v18M12 3v18M18 3v18M3 8h18M3 16h18" />,
} satisfies Record<string, ReactNode>

export type IconName = keyof typeof SHAPES

export const ICON_NAMES = Object.keys(SHAPES) as IconName[]

// 图标只是装饰：读屏读的是按钮或链接自己的名字，所以这里一律 aria-hidden。
// An icon is decoration: a screen reader reads the name of the button or link itself, so it is always aria-hidden here.
export function Icon({ name }: { name: IconName }) {
  return (
    <svg className="icon" viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      {SHAPES[name]}
    </svg>
  )
}
