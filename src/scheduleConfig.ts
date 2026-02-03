import defaultConfig from './schedules.json';
import type { FilenameRule, ScheduleDefinition, ScheduleId } from './schedules';

export interface FilenameRuleConfig {
  pattern: string;
  schedule: ScheduleId;
}

export interface ScheduleConfig {
  schedules: ScheduleDefinition[];
  filenameRules: FilenameRuleConfig[];
}

export interface CompiledScheduleConfig {
  schedules: ScheduleDefinition[];
  filenameRules: FilenameRule[];
}

export interface RulesAuditEntry {
  timestamp: string;
  editorName?: string;
  summary: string;
  beforeHash: string;
  afterHash: string;
}

const STORAGE_KEY = 'estate706.scheduleConfig.v1';
const AUDIT_KEY = 'estate706.rulesAudit.v1';
const EDITOR_KEY = 'estate706.rulesEditorName.v1';
const OVERRIDES_KEY = 'estate706.reviewOverrides.v1';

export function getDefaultConfig(): ScheduleConfig {
  return JSON.parse(JSON.stringify(defaultConfig)) as ScheduleConfig;
}

export function getStoredEditorName(): string {
  return localStorage.getItem(EDITOR_KEY) ?? '';
}

export function setStoredEditorName(name: string): void {
  localStorage.setItem(EDITOR_KEY, name);
}

export function validateScheduleConfig(raw: unknown): { config?: ScheduleConfig; errors: string[] } {
  const errors: string[] = [];
  if (!raw || typeof raw !== 'object') {
    return { errors: ['Config must be an object.'] };
  }
  const candidate = raw as ScheduleConfig;
  if (!Array.isArray(candidate.schedules)) {
    errors.push('Config.schedules must be an array.');
  }
  if (!Array.isArray(candidate.filenameRules)) {
    errors.push('Config.filenameRules must be an array.');
  }

  const schedules = Array.isArray(candidate.schedules) ? candidate.schedules : [];
  const filenameRules = Array.isArray(candidate.filenameRules) ? candidate.filenameRules : [];

  for (const [index, schedule] of schedules.entries()) {
    if (!schedule || typeof schedule !== 'object') {
      errors.push(`Schedule at index ${index} must be an object.`);
      continue;
    }
    if (typeof schedule.id !== 'string' || !schedule.id) {
      errors.push(`Schedule at index ${index} is missing a valid id.`);
    }
    if (typeof schedule.label !== 'string' || !schedule.label) {
      errors.push(`Schedule at index ${index} is missing a valid label.`);
    }
    if (!Array.isArray(schedule.keywords)) {
      errors.push(`Schedule "${schedule.id}" keywords must be an array.`);
    }
    if (!Array.isArray(schedule.smallTerms)) {
      errors.push(`Schedule "${schedule.id}" smallTerms must be an array.`);
    }
    for (const [termIndex, keyword] of (schedule.keywords ?? []).entries()) {
      if (typeof keyword.term !== 'string') {
        errors.push(`Schedule "${schedule.id}" keyword ${termIndex} term must be a string.`);
      }
      if (typeof keyword.weight !== 'number' || Number.isNaN(keyword.weight)) {
        errors.push(`Schedule "${schedule.id}" keyword ${termIndex} weight must be a number.`);
      }
    }
    for (const [termIndex, keyword] of (schedule.smallTerms ?? []).entries()) {
      if (typeof keyword.term !== 'string') {
        errors.push(`Schedule "${schedule.id}" smallTerm ${termIndex} term must be a string.`);
      }
      if (typeof keyword.weight !== 'number' || Number.isNaN(keyword.weight)) {
        errors.push(`Schedule "${schedule.id}" smallTerm ${termIndex} weight must be a number.`);
      }
    }
  }

  for (const [index, rule] of filenameRules.entries()) {
    if (!rule || typeof rule !== 'object') {
      errors.push(`Filename rule at index ${index} must be an object.`);
      continue;
    }
    if (typeof rule.pattern !== 'string' || !rule.pattern) {
      errors.push(`Filename rule at index ${index} pattern must be a string.`);
    } else {
      try {
        new RegExp(rule.pattern, 'i');
      } catch (error) {
        errors.push(`Filename rule "${rule.pattern}" is not a valid regex: ${String(error)}`);
      }
    }
    if (typeof rule.schedule !== 'string' || !rule.schedule) {
      errors.push(`Filename rule at index ${index} schedule must be a string.`);
    }
  }

  return errors.length > 0 ? { errors } : { config: candidate, errors: [] };
}

export function compileScheduleConfig(config: ScheduleConfig): CompiledScheduleConfig {
  return {
    schedules: config.schedules,
    filenameRules: config.filenameRules.map((rule) => ({
      pattern: new RegExp(rule.pattern, 'i'),
      schedule: rule.schedule,
    })),
  };
}

export function loadStoredScheduleConfig(): ScheduleConfig | null {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as ScheduleConfig;
    const { config, errors } = validateScheduleConfig(parsed);
    if (errors.length > 0 || !config) {
      return null;
    }
    return config;
  } catch {
    return null;
  }
}

export function saveScheduleConfig(config: ScheduleConfig): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(config, null, 2));
}

export function resetStoredScheduleConfig(): void {
  localStorage.removeItem(STORAGE_KEY);
}

export function loadRulesAuditLog(): RulesAuditEntry[] {
  const raw = localStorage.getItem(AUDIT_KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as RulesAuditEntry[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function appendRulesAuditEntry(entry: RulesAuditEntry): void {
  const current = loadRulesAuditLog();
  current.unshift(entry);
  localStorage.setItem(AUDIT_KEY, JSON.stringify(current.slice(0, 50), null, 2));
}

export function loadReviewOverrides(): Record<string, ScheduleId> {
  const raw = localStorage.getItem(OVERRIDES_KEY);
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as Record<string, ScheduleId>;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

export function saveReviewOverrides(overrides: Record<string, ScheduleId>): void {
  localStorage.setItem(OVERRIDES_KEY, JSON.stringify(overrides, null, 2));
}
