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
      className={`transition-all duration-700 ease-out ${
        visible ? 'opacity-100 translate-y-0 translate-x-0' : `will-change-transform opacity-0 ${hiddenTransform}`
      } ${className}`}
    >
      {children}
    </div>
  );
}

interface ParallaxBackdropProps {
  src: string;
  avifSrcSet?: string;
  webpSrcSet?: string;
  sizes?: string;
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
  avifSrcSet,
  webpSrcSet,
  sizes = '100vw',
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
      if (rect.bottom < -120 || rect.top > vh + 120) return;
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

  const imgEl = (
    <img
      ref={imgRef}
      src={src}
      alt={alt}
      loading={priority ? 'eager' : 'lazy'}
      fetchPriority={priority ? 'high' : undefined}
      decoding="async"
      style={{ transform: `scale(${baseScale})` }}
      className={`h-full w-full object-cover will-change-transform transition-transform duration-150 ease-out ${imgClassName}`}
    />
  );

  return (
    <div ref={containerRef} className="pointer-events-none absolute inset-0 overflow-hidden">
      {avifSrcSet || webpSrcSet ? (
        <picture className="block h-full w-full">
          {avifSrcSet && <source type="image/avif" srcSet={avifSrcSet} sizes={sizes} />}
          {webpSrcSet && <source type="image/webp" srcSet={webpSrcSet} sizes={sizes} />}
          {imgEl}
        </picture>
      ) : (
        imgEl
      )}
    </div>
  );
}

export function ScrollProgressBar() {
  const barRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let raf = 0;
    const calc = () => {
      raf = 0;
      const bar = barRef.current;
      if (!bar) return;
      const doc = document.documentElement;
      const max = Math.max(1, doc.scrollHeight - window.innerHeight);
      const ratio = Math.min(1, Math.max(0, window.scrollY / max));
      bar.style.transform = `scaleX(${ratio.toFixed(4)})`;
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
        ref={barRef}
        className="h-full w-full origin-left bg-gradient-to-r from-[#0F275C] via-[#E11D48] to-[#FB7185]"
        style={{ transform: 'scaleX(0)' }}
      />
    </div>
  );
}
