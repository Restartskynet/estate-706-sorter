import { countTermOccurrences, normalizeText } from './normalize';
import type { CompiledScheduleConfig } from './scheduleConfig';
import type { ScheduleDefinition, ScheduleId } from './schedules';

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

export interface PdfScanMetrics {
  chars: number;
  textItems: number;
  pagesSampled: number;
}

export interface ScannedDetectionThresholds {
  minChars: number;
  minTextItems: number;
}

export function applyFilenameRules(filename: string, config: CompiledScheduleConfig): ScheduleId | null {
  for (const rule of config.filenameRules) {
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
  config: CompiledScheduleConfig;
  pdfMetrics?: PdfScanMetrics;
  scannedThresholds: ScannedDetectionThresholds;
}): ClassificationResult {
  const normalizedFilename = normalizeText(options.filename);
  const filenameMatch = applyFilenameRules(normalizedFilename, options.config);
  const scores = {} as Record<ScheduleId, number>;

  if (filenameMatch) {
    for (const schedule of options.config.schedules) {
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

  if (options.isPdf && options.pdfMetrics && options.pdfMetrics.pagesSampled > 0) {
    const lowChars = options.pdfMetrics.chars < options.scannedThresholds.minChars;
    const lowItems = options.pdfMetrics.textItems < options.scannedThresholds.minTextItems;
    if (lowChars || lowItems) {
      for (const schedule of options.config.schedules) {
        scores[schedule.id] = 0;
      }
      return {
        decision: 'review',
        candidate: 'Unknown',
        reason: `likely_scanned_pdf: low_text_layer (chars=${options.pdfMetrics.chars}, textItems=${options.pdfMetrics.textItems}, sampled=${options.pdfMetrics.pagesSampled})`,
        score: 0,
        scores,
      };
    }
  }

  if (!options.text.trim()) {
    for (const schedule of options.config.schedules) {
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

  for (const schedule of options.config.schedules) {
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
