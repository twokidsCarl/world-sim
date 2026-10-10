const PATHS = {
  eye: 'M1.5 8s2.4-4.5 6.5-4.5S14.5 8 14.5 8s-2.4 4.5-6.5 4.5S1.5 8 1.5 8Zm6.5 2.2a2.2 2.2 0 1 0 0-4.4 2.2 2.2 0 0 0 0 4.4Z',
  eyeOff: 'M2 2l12 12M6.2 4A6.6 6.6 0 0 1 8 3.5c4.1 0 6.5 4.5 6.5 4.5a11 11 0 0 1-2 2.6M9.9 9.9A2.2 2.2 0 0 1 6.1 6.1M4.1 5.3A10.600 10.600 0 0 0 1.500 8s2.400 4.500 6.500 4.500c.7 0 1.300-.1 1.900-.3',
  chevron: 'M6 3.5 10.5 8 6 12.5',
  search: 'M7 12A5 5 0 1 0 7 2a5 5 0 0 0 0 10Zm3.6-1.400L14 14',
  close: 'M3.500 3.500l9 9m0-9-9 9',
  layers: 'M8 2 1.500 5.500 8 9l6.500-3.500L8 2ZM1.500 8.500 8 12l6.500-3.500M1.500 11.200 8 14.700l6.500-3.500',
  info: 'M8 14.500a6.500 6.500 0 1 0 0-13 6.500 6.500 0 0 0 0 13ZM8 7.200v4M8 4.700v.6',
  target: 'M8 13.500a5.500 5.500 0 1 0 0-11 5.500 5.500 0 0 0 0 11ZM8 .800v3M8 12.200v3M.800 8h3M12.200 8h3',
  home: 'M2 7.500 8 2.500l6 5M3.500 6.500V13.500h9V6.500',
  flip: 'M8 1.500v13M5.500 4 2 8l3.500 4V4ZM10.500 4 14 8l-3.500 4V4Z',
} as const

export type IconName = keyof typeof PATHS

export function Icon({ name, size = 16 }: { name: IconName; size?: number }) {
  return (
    <svg
      className="icon"
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={PATHS[name]} />
    </svg>
  )
}
