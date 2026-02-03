import { countTermOccurrences, normalizeText } from './normalize';
import { FILENAME_RULES, type ScheduleDefinition, type ScheduleId, SCHEDULES } from './schedules';

export const MIN_TEXT_CHARS = 250;
export const SCORE_FLOOR = 18;
export const LOW_CONFIDENCE_MARGIN = 6;

export type ClassificationDecision = 'assigned' | 'review';

export interface ClassificationResult {
  decision: ClassificationDecision;
  schedule?: ScheduleId;
  candidate?: ScheduleId | 'Unknown';
  reason: string;
  score: number;
  scores: Record<ScheduleId, number>;
}

const schedulesById = new Map<ScheduleId, ScheduleDefinition>(
  SCHEDULES.map((schedule) => [schedule.id, schedule])
);

export function applyFilenameRules(filename: string): ScheduleId | null {
  for (const rule of FILENAME_RULES) {
    if (rule.pattern.test(filename)) {
      return rule.schedule;
    }
  }
  return null;
}

function scoreSchedule(text: string, schedule: ScheduleDefinition): number {
  let score = 0;
  for (const keyword of schedule.keywords) {
    score += countTermOccurrences(text, keyword.term) * keyword.weight;
  }
  for (const term of schedule.smallTerms) {
    score += countTermOccurrences(text, term.term) * term.weight;
  }
  return score;
}

export function classifyDocument(options: {
  filename: string;
  text: string;
  isPdf: boolean;
}): ClassificationResult {
  const normalizedFilename = normalizeText(options.filename);
  const filenameMatch = applyFilenameRules(normalizedFilename);
  const scores = {} as Record<ScheduleId, number>;

  if (filenameMatch) {
    for (const schedule of SCHEDULES) {
      scores[schedule.id] = schedule.id === filenameMatch ? SCORE_FLOOR : 0;
    }
    return {
      decision: 'assigned',
      schedule: filenameMatch,
      reason: 'filename_rule',
      score: SCORE_FLOOR,
      scores,
    };
  }

  if (options.isPdf && options.text.trim().length < MIN_TEXT_CHARS) {
    for (const schedule of SCHEDULES) {
      scores[schedule.id] = 0;
    }
    return {
      decision: 'review',
      candidate: 'Unknown',
      reason: 'pdf_text_too_small (likely scanned; needs OCR)',
      score: 0,
      scores,
    };
  }

  if (!options.text.trim()) {
    for (const schedule of SCHEDULES) {
      scores[schedule.id] = 0;
    }
    return {
      decision: 'review',
      candidate: 'Unknown',
      reason: 'no_text_or_filename_rule',
      score: 0,
      scores,
    };
  }

  for (const schedule of SCHEDULES) {
    scores[schedule.id] = scoreSchedule(options.text, schedule);
  }

  const sorted = Object.entries(scores).sort((a, b) => b[1] - a[1]);
  const [bestScheduleId, bestScore] = sorted[0] as [ScheduleId, number];
  const runnerUpScore = sorted[1]?.[1] ?? 0;
  const margin = bestScore - runnerUpScore;

  if (bestScore < SCORE_FLOOR || margin < LOW_CONFIDENCE_MARGIN) {
    return {
      decision: 'review',
      candidate: bestScheduleId ?? 'Unknown',
      reason: 'low_confidence',
      score: bestScore,
      scores,
    };
  }

  return {
    decision: 'assigned',
    schedule: bestScheduleId,
    reason: 'keyword_score',
    score: bestScore,
    scores,
  };
}

export function getScheduleLabel(scheduleId: ScheduleId): string {
  return schedulesById.get(scheduleId)?.label ?? scheduleId;
}
