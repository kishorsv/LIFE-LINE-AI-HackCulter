import { useId } from 'react';

export interface LifeLineLogoProps {
  /** 'full' = icon + wordmark (+ optional subtitle); 'compact' = icon + concise wordmark; 'mark' = shield icon only */
  variant?: 'full' | 'compact' | 'mark';
  /** Visual scale preset */
  size?: 'xs' | 'sm' | 'md' | 'lg' | 'xl';
  /** Optional subtitle below brand text (rendered when showSubtitle is true in 'full' variant) */
  subtitle?: string;
  /** Whether to show the subtitle under LIFE-LINE AI */
  showSubtitle?: boolean;
  /** Override theme polarity when rendered on a fixed-dark or fixed-light surface */
  tone?: 'auto' | 'light' | 'dark';
  /** Subtle ECG pulse glow animation for loading screens */
  animated?: boolean;
  className?: string;
}

const SIZE_MAP = {
  xs: {
    icon: 24,
    text: 'text-sm',
    sub: 'text-[8.5px]',
    gap: 'gap-2',
  },
  sm: {
    icon: 36,
    text: 'text-base',
    sub: 'text-[9.5px]',
    gap: 'gap-2.5',
  },
  md: {
    icon: 42,
    text: 'text-lg',
    sub: 'text-[10px]',
    gap: 'gap-3',
  },
  lg: {
    icon: 56,
    text: 'text-2xl',
    sub: 'text-[11px]',
    gap: 'gap-3.5',
  },
  xl: {
    icon: 72,
    text: 'text-3xl',
    sub: 'text-xs',
    gap: 'gap-4',
  },
} as const;

export function LifeLineLogo({
  variant = 'full',
  size = 'sm',
  subtitle = 'SAFETY INTELLIGENCE',
  showSubtitle = false,
  tone = 'auto',
  animated = false,
  className = '',
}: LifeLineLogoProps) {
  const uid = useId().replace(/:/g, '');
  const spec = SIZE_MAP[size];

  const primaryTextClass =
    tone === 'dark'
      ? 'text-white'
      : tone === 'light'
      ? 'text-[#0A1633]'
      : 'text-[#0A1633] dark:text-white';

  const aiAccentClass =
    tone === 'dark'
      ? 'text-[#FB7185]'
      : tone === 'light'
      ? 'text-[#E11D48]'
      : 'text-[#E11D48] dark:text-[#FB7185]';

  const subtitleClass =
    tone === 'dark'
      ? 'text-slate-300'
      : tone === 'light'
      ? 'text-slate-500'
      : 'text-slate-500 dark:text-slate-400';

  const outerRimClass =
    tone === 'dark'
      ? 'stroke-white/85'
      : tone === 'light'
      ? 'stroke-[#0A1633]'
      : 'stroke-[#0A1633] dark:stroke-white/85';

  return (
    <span className={`inline-flex items-center ${spec.gap} select-none ${className}`}>
      {/* Vector Shield + ECG Pulse + Subtle AI Intelligence Mark */}
      <svg
        width={spec.icon}
        height={spec.icon}
        viewBox="0 0 48 48"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
        role="img"
        aria-label="LIFE-LINE AI Shield Emblem"
        className="shrink-0 drop-shadow-sm"
      >
        <defs>
          <linearGradient id={`ll-navy-${uid}`} x1="8" y1="4" x2="40" y2="44" gradientUnits="userSpaceOnUse">
            <stop offset="0%" stopColor="#0F2147" />
            <stop offset="55%" stopColor="#0A1633" />
            <stop offset="100%" stopColor="#050C1F" />
          </linearGradient>
          <linearGradient id={`ll-red-${uid}`} x1="16" y1="18" x2="32" y2="35" gradientUnits="userSpaceOnUse">
            <stop offset="0%" stopColor="#FB3748" />
            <stop offset="100%" stopColor="#E11D48" />
          </linearGradient>
        </defs>

        {/* Protective Shield Base (Midnight Navy) */}
        <path
          d="M24 3.5L41 10.2V22.4C41 33.6 33.7 41.5 24 44.8C14.3 41.5 7 33.6 7 22.4V10.2L24 3.5Z"
          fill={`url(#ll-navy-${uid})`}
          className={outerRimClass}
          strokeWidth="2.1"
          strokeLinejoin="round"
        />

        {/* Subtle Architectural Right-Half Depth Facet */}
        <path
          d="M24 4.5L40 10.8V22.4C40 33 33.1 40.5 24 43.7V4.5Z"
          fill="#040A1A"
          fillOpacity="0.28"
        />

        {/* Crisp Inner Protective Shield Rim */}
        <path
          d="M24 6.8L38 12.3V22.3C38 31.6 32 38.3 24 41.4C16 38.3 10 31.6 10 22.3V12.3L24 6.8Z"
          stroke="#FFFFFF"
          strokeOpacity="0.18"
          strokeWidth="1"
          strokeLinejoin="round"
        />

        {/* Subtle AI Intelligence Neural Triad (Upper Chamber) */}
        <path
          d="M16.5 16.4H20.4L24 12.4L27.6 16.4H31.5"
          stroke="#FFFFFF"
          strokeOpacity="0.88"
          strokeWidth="1.45"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <circle cx="16.2" cy="16.4" r="1.45" fill="#FFFFFF" />
        <circle cx="31.8" cy="16.4" r="1.45" fill="#FFFFFF" />
        {/* AI Intelligence Core Diamond */}
        <path d="M24 9.5L26.8 12.3L24 15.1L21.2 12.3Z" fill="#FFFFFF" />
        <circle cx="24" cy="12.3" r="1.2" fill="#E11D48" />

        {/* Integrated Heartbeat / ECG Pulse (White Lead Wings + Emergency Red Cardiac Spike) */}
        <path
          d="M9.8 27H16.2"
          stroke="#FFFFFF"
          strokeWidth="2.5"
          strokeLinecap="round"
        />
        <path
          d="M31.8 27H38.2"
          stroke="#FFFFFF"
          strokeWidth="2.5"
          strokeLinecap="round"
        />
        <path
          d="M16.2 27L18.4 30.8L22.2 18.8L26.2 35.2L29.4 24.4L31.8 27"
          stroke={`url(#ll-red-${uid})`}
          strokeWidth="2.9"
          strokeLinecap="round"
          strokeLinejoin="round"
          className={animated ? 'animate-pulse' : undefined}
        />

        {/* Lower Apex Structural Chevron */}
        <path
          d="M21 37.2L24 39.6L27 37.2"
          stroke="#FFFFFF"
          strokeOpacity="0.45"
          strokeWidth="1.4"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>

      {/* Wordmark Lockup */}
      {variant !== 'mark' && (
        <span className="flex flex-col leading-none">
          <span className={`font-display ${spec.text} font-extrabold tracking-tight whitespace-nowrap ${primaryTextClass}`}>
            LIFE-LINE{' '}
            <span className={aiAccentClass}>AI</span>
          </span>
          {variant === 'full' && showSubtitle && subtitle && (
            <span className={`${spec.sub} font-semibold uppercase tracking-[0.16em] mt-1 whitespace-nowrap ${subtitleClass}`}>
              {subtitle}
            </span>
          )}
        </span>
      )}
    </span>
  );
}
