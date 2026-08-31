import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { checkMeasuredBudgets, loadPerformanceBudgets } from '../../scripts/check-budgets.mjs';

const validBudgets = {
  backgroundBytes: 10,
  panelBytes: 20,
  contentBytes: 30,
  coreToolSchemaChars: 40,
  fullToolSchemaChars: 50,
};

describe('performance budget checker', () => {
  it('pins reviewed production budgets', () => {
    expect(loadPerformanceBudgets(path.resolve('config/performance-budgets.json'))).toEqual({
      backgroundBytes: 1_050_000,
      panelBytes: 230_000,
      contentBytes: 120_000,
      coreToolSchemaChars: 12_000,
      fullToolSchemaChars: 33_000,
    });
  });

  it('fails when budget file is missing', () => {
    expect(() => loadPerformanceBudgets(path.join(os.tmpdir(), `missing-${Date.now()}.json`))).toThrow(
      /Budget file missing/,
    );
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, -1, 0])('rejects invalid budget value %s', (value) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'glide-budget-test-'));
    const budgetPath = path.join(dir, 'budgets.json');
    fs.writeFileSync(budgetPath, JSON.stringify({ ...validBudgets, panelBytes: value }));
    expect(() => loadPerformanceBudgets(budgetPath)).toThrow(/panelBytes must be a finite positive number/);
  });

  it('reports measured and allowed values for exceeded budgets', () => {
    const result = checkMeasuredBudgets(validBudgets, { ...validBudgets, panelBytes: 21 });
    expect(result.passed).toBe(false);
    expect(result.errors).toContain('panelBytes measured 21 > allowed 20');
  });

  it('passes when every measurement is at or below its budget', () => {
    expect(checkMeasuredBudgets(validBudgets, validBudgets)).toEqual({ passed: true, errors: [] });
  });
});
