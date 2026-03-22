import React, { useState } from 'react';
import s from './PeriodSelector.module.css';

const PRESETS = [
  { label: '30 days', value: 30 },
  { label: '60 days', value: 60 },
  { label: '90 days', value: 90 },
  { label: 'Custom', value: 'custom' },
];

export default function PeriodSelector({ value, onChange }) {
  const [customVal, setCustomVal] = useState('');
  const isCustom = !PRESETS.slice(0, -1).some((p) => p.value === value);

  function handlePreset(val) {
    if (val === 'custom') {
      const c = parseInt(customVal) || 45;
      setCustomVal(String(c));
      onChange(c);
    } else {
      onChange(val);
    }
  }

  function handleCustomChange(e) {
    const v = e.target.value.replace(/\D/g, '');
    setCustomVal(v);
    if (v && parseInt(v) > 0) onChange(parseInt(v));
  }

  return (
    <div className={s.wrap}>
      <span className={s.label}>Period:</span>
      <div className={s.presets}>
        {PRESETS.map((p) => {
          const active = p.value === 'custom' ? isCustom : p.value === value;
          return (
            <button
              key={p.value}
              className={active ? `${s.btn} ${s.active}` : s.btn}
              onClick={() => handlePreset(p.value)}
              type="button"
            >
              {p.label}
            </button>
          );
        })}
      </div>
      {isCustom && (
        <div className={s.customWrap}>
          <input
            className={s.customInput}
            type="number"
            min="1"
            max="3650"
            value={customVal}
            onChange={handleCustomChange}
            placeholder="e.g. 45"
          />
          <span className={s.customLabel}>days</span>
        </div>
      )}
    </div>
  );
}
