import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { classifyDocument } from '../src/classify.ts';
import { compileScheduleConfig, getDefaultConfig } from '../src/scheduleConfig.ts';

const fixtureText = await readFile(new URL('./fixtures/golden-set.json', import.meta.url), 'utf8');
const fixtures = JSON.parse(fixtureText) as Array<{
  filename: string;
  text: string;
  isPdf: boolean;
  expectedDecision: 'assigned' | 'review';
  expectedSchedule?: string;
}>;

const config = compileScheduleConfig(getDefaultConfig());

const thresholds = {
  minChars: 250,
  minTextItems: 30,
};

test('golden set classification', () => {
  for (const fixture of fixtures) {
    const result = classifyDocument({
      filename: fixture.filename,
      text: fixture.text,
      isPdf: fixture.isPdf,
      config,
      scannedThresholds: thresholds,
    });

    assert.equal(result.decision, fixture.expectedDecision);
    if (fixture.expectedSchedule) {
      assert.equal(result.schedule, fixture.expectedSchedule);
    }
  }
});
