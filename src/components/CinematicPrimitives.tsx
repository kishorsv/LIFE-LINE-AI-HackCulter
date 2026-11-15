import React, { useEffect, useRef, useState } from 'react';

export function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState<boolean>(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  });

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    const onChange = () => setReduced(mq.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);

  return reduced;
}

interface ScrollRevealProps {
  children: React.ReactNode;
  delayMs?: number;
  className?: string;
  direction?: 'up' | 'left' | 'right' | 'none';
}

export function ScrollReveal({
  children,
  delayMs = 0,
  className = '',
  direction = 'up',
}: ScrollRevealProps) {
  const ref = useRef<HTMLDivElement | null>(null);
  const reducedMotion = usePrefersReducedMotion();
  const [visible, setVisible] = useState<boolean>(reducedMotion);

  useEffect(() => {
    if (reducedMotion) {
      setVisible(true);
      return;
    }
    const el = ref.current;
    if (!el || typeof IntersectionObserver === 'undefined') {
      setVisible(true);
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            setVisible(true);
            observer.unobserve(entry.target);
          }
        }
      },
      { threshold: 0.12, rootMargin: '0px 0px -40px 0px' }
    );

    observer.observe(el);
    return () => observer.disconnect();
  }, [reducedMotion]);

  const hiddenTransform =
    direction === 'up'
      ? 'translate-y-7'
      : direction === 'left'
      ? '-translate-x-7'
      : direction === 'right'
      ? 'translate-x-7'
      : '';

  return (
    <div
      ref={ref}
      style={reducedMotion ? undefined : { transitionDelay: `${delayMs}ms` }}
      className={`transition-all duration-700 ease-out will-change-transform ${
        visible ? 'opacity-100 translate-y-0 translate-x-0' : `opacity-0 ${hiddenTransform}`
      } ${className}`}
    >
      {children}
    </div>
  );
}

interface ParallaxBackdropProps {
  src: string;
  alt: string;
  /** Initial zoom factor (use >= 1.04 if cropping subtle borders) */
  baseScale?: number;
  /** Max vertical parallax shift in px */
  parallaxRange?: number;
  /** Additional zoom delta while scrolling through viewport */
  zoomDelta?: number;
  imgClassName?: string;
  priority?: boolean;
}

export function ParallaxBackdrop({
  src,
  alt,
  baseScale = 1.05,
  parallaxRange = 36,
  zoomDelta = 0.06,
  imgClassName = 'object-center',
  priority = false,
}: ParallaxBackdropProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);
  const reducedMotion = usePrefersReducedMotion();

  useEffect(() => {
    if (reducedMotion) return;
    let rafId = 0;

    const updateTransform = () => {
      rafId = 0;
      const container = containerRef.current;
      const img = imgRef.current;
      if (!container || !img) return;
      const rect = container.getBoundingClientRect();
      const vh = window.innerHeight || 900;
      const total = vh + rect.height;
      const progress = Math.min(1, Math.max(0, (vh - rect.top) / total));
      const translateY = (progress - 0.5) * parallaxRange * 2;
      const scale = baseScale + progress * zoomDelta;
      img.style.transform = `translate3d(0, ${translateY.toFixed(2)}px, 0) scale(${scale.toFixed(4)})`;
    };

    const onScroll = () => {
      if (!rafId) {
        rafId = window.requestAnimationFrame(updateTransform);
      }
    };

    updateTransform();
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll, { passive: true });
    return () => {
      if (rafId) window.cancelAnimationFrame(rafId);
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onScroll);
    };
  }, [reducedMotion, baseScale, parallaxRange, zoomDelta]);

  return (
    <div ref={containerRef} className="pointer-events-none absolute inset-0 overflow-hidden">
      <img
        ref={imgRef}
        src={src}
        alt={alt}
        loading={priority ? 'eager' : 'lazy'}
        decoding="async"
        style={reducedMotion ? { transform: `scale(${baseScale})` } : { transform: `scale(${baseScale})` }}
        className={`h-full w-full object-cover will-change-transform transition-transform duration-150 ease-out ${imgClassName}`}
      />
    </div>
  );
}

export function ScrollProgressBar() {
  const [progress, setProgress] = useState(0);

  useEffect(() => {
    let raf = 0;
    const calc = () => {
      raf = 0;
      const doc = document.documentElement;
      const max = Math.max(1, doc.scrollHeight - window.innerHeight);
      setProgress(Math.min(100, Math.max(0, (window.scrollY / max) * 100)));
    };
    const onScroll = () => {
      if (!raf) raf = window.requestAnimationFrame(calc);
    };
    calc();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      if (raf) window.cancelAnimationFrame(raf);
      window.removeEventListener('scroll', onScroll);
    };
  }, []);

  return (
    <div
      aria-hidden="true"
      className="pointer-events-none fixed left-0 right-0 top-0 z-50 h-[2px] bg-transparent"
    >
      <div
        className="h-full bg-gradient-to-r from-[#0F275C] via-[#E11D48] to-[#FB7185] transition-[width] duration-75"
        style={{ width: `${progress}%` }}
      />
    </div>
  );
}
