import { useMemo } from 'react';

interface Drop {
  id: number;
  left: number;
  delay: number;
  duration: number;
  opacity: number;
  width: number;
  height: number;
}

function generateDrops(count: number): Drop[] {
  const drops: Drop[] = [];
  for (let i = 0; i < count; i++) {
    drops.push({
      id: i,
      left: Math.random() * 100,
      delay: Math.random() * 4,
      duration: 0.6 + Math.random() * 0.8,
      opacity: 0.15 + Math.random() * 0.35,
      width: 1 + Math.random() * 1,
      height: 12 + Math.random() * 20,
    });
  }
  return drops;
}

export default function RainEffect({ contained = false }: { contained?: boolean }) {
  const drops = useMemo(() => generateDrops(120), []);

  return (
    <div
      className={`${contained ? 'absolute' : 'fixed'} inset-0 pointer-events-none overflow-hidden`}
      style={{ zIndex: contained ? 1 : 6 }}
      aria-hidden
    >
      {drops.map((drop) => (
        <span
          key={drop.id}
          style={{
            position: 'absolute',
            left: `${drop.left}%`,
            top: '-30px',
            width: `${drop.width}px`,
            height: `${drop.height}px`,
            borderRadius: '0 0 2px 2px',
            background: `linear-gradient(to bottom, transparent, rgba(174,214,241,${drop.opacity}))`,
            animationName: 'rain-fall',
            animationDuration: `${drop.duration}s`,
            animationDelay: `${drop.delay}s`,
            animationTimingFunction: 'linear',
            animationIterationCount: 'infinite',
          }}
        />
      ))}
      <style>{`
        @keyframes rain-fall {
          0%   { transform: translateY(0); opacity: 0; }
          10%  { opacity: 1; }
          90%  { opacity: 1; }
          100% { transform: translateY(110vh); opacity: 0; }
        }
      `}</style>
    </div>
  );
}
