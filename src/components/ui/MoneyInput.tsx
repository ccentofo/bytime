'use client';

import { useState } from 'react';
import { NumberInput, type NumberInputProps } from '@mantine/core';
import { formatCurrency } from '@/lib/format';

type Props = Omit<NumberInputProps, 'value' | 'onChange' | 'onValueChange' | 'max' | 'min' | 'prefix' | 'thousandSeparator' | 'decimalScale' | 'allowNegative'> & {
  /** A plain numeric string ('' for empty), never a float — the server validates and stores it exactly. */
  value: string;
  onChange: (value: string) => void;
  /** Checked on blur with an inline error; the server enforces it too. Never forwarded (NumberInput would clamp). */
  max?: number;
};

/**
 * A dollar amount (feature-plan-ux-kit-contracts.md §3.7). A comma is only ever a thousands separator — never a decimal
 * (Mantine defaults to both) — so typing "1,234.5" or pasting "1,234,567.89" / "$1,234.50" gives "1234.5" /
 * "1234567.89" / "1234.50". Two decimals at most: a pasted third is truncated, and the input shows the result. Only
 * the user's own edits reach onChange (`source === 'event'`), so a prop update never loops back.
 */
export function MoneyInput({ value, onChange, max, onBlur, error, ...rest }: Props) {
  const [overMax, setOverMax] = useState(false);
  return (
    <NumberInput
      {...rest}
      value={value}
      prefix="$"
      thousandSeparator=","
      allowedDecimalSeparators={['.']}
      decimalScale={2}
      allowNegative={false}
      hideControls
      inputMode="decimal"
      clampBehavior="none"
      onValueChange={(values, info) => {
        if (info.source !== 'event') return;
        setOverMax(false);
        onChange(values.value);
      }}
      onBlur={(e) => {
        setOverMax(max !== undefined && value !== '' && Number(value) > max);
        onBlur?.(e);
      }}
      error={overMax && max !== undefined ? `Must be at most ${formatCurrency(max)}.` : error}
    />
  );
}
