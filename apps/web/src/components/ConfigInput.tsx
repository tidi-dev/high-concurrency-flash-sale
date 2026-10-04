import type { DemoConfig } from '@flash/shared';
import { useEffect, useRef, useState } from 'react';
import { patchConfig } from '../api';

type NumericKey = { [K in keyof DemoConfig]: DemoConfig[K] extends number ? K : never }[keyof DemoConfig];

/**
 * A number/range input bound to a demo knob. Keeps a local value while you interact and sends a
 * debounced PATCH, so the 500ms server refresh doesn't fight your mouse.
 */
export function ConfigNumber(props: { name: NumericKey; value: number; type: 'range' | 'number'; min: number; max: number; step?: number; label: (v: number) => React.ReactNode }) {
  const [local, setLocal] = useState(props.value);
  const editing = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!editing.current) setLocal(props.value);
  }, [props.value]);

  const change = (v: number) => {
    setLocal(v);
    if (editing.current) clearTimeout(editing.current);
    editing.current = setTimeout(() => {
      void patchConfig({ [props.name]: v } as Partial<DemoConfig>).finally(() => {
        editing.current = null;
      });
    }, 250);
  };

  return (
    <label>
      {props.label(local)}
      <input type={props.type} min={props.min} max={props.max} step={props.step ?? 1} value={local} onChange={(e) => change(Number(e.target.value))} />
    </label>
  );
}
