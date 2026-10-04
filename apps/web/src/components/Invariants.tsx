import type { Invariant } from '@flash/shared';

export function Invariants({ items }: { items: Invariant[] }) {
  if (!items.length) return null;
  return (
    <ul className="invariants">
      {items.map((i) => (
        <li key={i.id} className={i.ok ? 'ok' : 'bad'}>
          <span className="inv-mark">{i.ok ? '✔' : '✘'}</span>
          <span className="inv-label">{i.label}</span>
          <span className="inv-detail">{i.detail}</span>
        </li>
      ))}
    </ul>
  );
}
