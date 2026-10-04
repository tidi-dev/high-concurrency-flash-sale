import { ReactNode, useEffect, useRef, useState } from 'react';

/** Adds a short "pulse" class whenever `value` changes, so you can see where traffic is flowing. */
function usePulse(value: unknown): boolean {
  const [on, setOn] = useState(false);
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    setOn(true);
    const t = setTimeout(() => setOn(false), 450);
    return () => clearTimeout(t);
  }, [value]);
  return on;
}

export function Node(props: {
  icon: string;
  title: string;
  subtitle?: string;
  pulseOn: unknown;
  tone?: 'normal' | 'danger' | 'warn' | 'muted';
  badge?: ReactNode;
  children: ReactNode;
}) {
  const pulse = usePulse(props.pulseOn);
  return (
    <div className={`node tone-${props.tone ?? 'normal'} ${pulse ? 'pulse' : ''}`}>
      <div className="node-head">
        <span className="node-icon" aria-hidden>
          {props.icon}
        </span>
        <div>
          <div className="node-title">{props.title}</div>
          {props.subtitle && <div className="node-sub">{props.subtitle}</div>}
        </div>
        {props.badge && <div className="node-badge">{props.badge}</div>}
      </div>
      <div className="node-body">{props.children}</div>
    </div>
  );
}

/** The arrow between two nodes; animates while traffic flows. */
export function Flow({ rate, label }: { rate: number; label?: string }) {
  return (
    <div className={`flow ${rate > 0 ? 'active' : ''}`}>
      <div className="flow-line" />
      <div className="flow-label">{rate > 0 ? `${rate.toLocaleString('en-US')}/s` : ''}{label ? ` ${label}` : ''}</div>
    </div>
  );
}

export function Stat({ label, value, tone }: { label: string; value: ReactNode; tone?: 'danger' | 'ok' | 'warn' | 'muted' }) {
  return (
    <div className="stat">
      <span className="stat-label">{label}</span>
      <span className={`stat-value ${tone ? `t-${tone}` : ''}`}>{value}</span>
    </div>
  );
}
