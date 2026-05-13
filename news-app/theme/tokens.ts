export const colors = {
  bg: {
    primary: '#f9f9f7',
    card: '#ffffff',
    hover: '#F0EDE8',
    pill: '#2d3432',          // dark pill/tag background
    pillPressed: '#3f3f46',   // pressed state
    subtle: '#fafafa',        // rail/sidebar backgrounds
  },
  text: {
    primary: '#18181b',
    body: '#27272a',          // body text, form labels, synthesis content
    dim: '#3f3f46',           // dimmed labels, cta text, source titles
    secondary: '#71717a',
    tertiary: '#a1a1aa',
    muted: '#9E9690',         // warm gray — thinking indicator, bullet dots
    inverse: '#ffffff',
  },
  border: {
    subtle: '#f4f4f5',
    default: '#e4e4e7',
    medium: '#d4d4d8',        // form inputs, button outlines
    warm: '#E0DDD6',          // feedback button border
    warmHover: '#C8C4BE',     // feedback button hover border
  },
  status: {
    error: '#b91c1c',
    errorBright: '#ef4444',   // validation errors, inline form errors
    success: '#16a34a',
    successBg: '#F0FDF4',
  },
  brand: {
    accent: '#D84315',
    brief: '#6e77e3',
  },
}

export const typography = {
  family: {
    heading: 'Manrope',
    body: 'Space Grotesk',
  },
  size: {
    xs: 9,
    sm: 10,
    base: 12,
    md: 13,
    lg: 14,
    xl: 16,
    '2xl': 18,
    '3xl': 20,
    '4xl': 28,
  },
  weight: {
    medium: '500' as const,
    semibold: '600' as const,
    bold: '700' as const,
    extrabold: '800' as const,
  },
  tracking: {
    tight: -0.5,
    normal: 0,
    wide: 1,
    wider: 2,
  },
  leading: {
    tight: 18,
    normal: 20,
    relaxed: 22,
  },
}

export const spacing: Record<1 | 2 | 3 | 4 | 6 | 8, number> = {
  1: 4,
  2: 8,
  3: 12,
  4: 16,
  6: 24,
  8: 32,
}

export const shadows = {
  card: {
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.06,
    shadowRadius: 4,
    elevation: 2,
  },
  modal: {
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.15,
    shadowRadius: 16,
    elevation: 8,
  },
}

export const surfaces = {
  glass: { backgroundColor: 'rgba(255,255,255,0.7)' },
  pill: { backgroundColor: '#1A1A1A' },
  frosted: { backgroundColor: 'rgba(249,249,247,0.85)' },
}
