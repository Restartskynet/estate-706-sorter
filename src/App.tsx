import { useMemo, useRef, useState } from 'react';
import './App.css';
import { classifyDocument, SCORE_FLOOR, type ScannedDetectionThresholds } from './classify';
import { hashArrayBuffer } from './hash';
import { extractPdfText, type PdfTextResult } from './pdfText';
import {
  appendRulesAuditEntry,
  compileScheduleConfig,
  getDefaultConfig,
  getStoredEditorName,
  loadReviewOverrides,
  loadRulesAuditLog,
  loadStoredScheduleConfig,
  resetStoredScheduleConfig,
  saveReviewOverrides,
  saveScheduleConfig,
  setStoredEditorName,
  validateScheduleConfig,
  type RulesAuditEntry,
  type ScheduleConfig,
} from './scheduleConfig';
import type { ScheduleId } from './schedules';
import { normalizeText } from './normalize';
import { buildZip, downloadBlob, type ZipFileInput } from './zipExport';

interface SelectedFile {
  file: File;
  relativePath: string;
}

interface ProcessedFile {
  file: File;
  name: string;
  relativePath: string;
  size: number;
  type: string;
  hash: string;
  hashPrefix: string;
  decision: 'duplicate' | 'review' | 'assigned';
  schedule?: ScheduleId;
  candidate?: ScheduleId | 'Unknown';
  reason: string;
  score: number;
  outputPath: string;
  scores: Record<ScheduleId, number>;
  pdfMetrics?: PdfTextResult;
  textSample?: string;
  overrideApplied?: boolean;
}

interface DuplicateGroup {
  hash: string;
  hashPrefix: string;
  count: number;
  sourcePaths: string[];
  keptName: string;
  duplicateNames: string[];
}

type ExportMode = 'full' | '706-only' | 'duplicates-only' | 'reports-only';

type ReviewFilter = 'all' | 'scanned' | 'pdf_error' | 'low_confidence';

type Cluster = {
  id: string;
  tokens: string[];
  items: ProcessedFile[];
};

const ACCEPTED_EXTENSIONS = ['.pdf', '.png', '.jpg', '.jpeg', '.tiff', '.tif'];
const DEFAULT_SCAN_THRESHOLDS: ScannedDetectionThresholds = {
  minChars: 250,
  minTextItems: 30,
};

function isPdfFile(filename: string): boolean {
  return filename.toLowerCase().endsWith('.pdf');
}

function getRelativePath(file: File): string {
  const relativePath = (file as File & { webkitRelativePath?: string }).webkitRelativePath;
  return relativePath && relativePath.length > 0 ? relativePath : file.name;
}

function getHashPrefix(hash: string): string {
  return hash.slice(0, 10);
}

function buildCsv(rows: string[][]): string {
  return rows
    .map((row) =>
      row
        .map((value) => {
          const escaped = String(value ?? '').replace(/"/g, '""');
          return `"${escaped}"`;
        })
        .join(',')
    )
    .join('\n');
}

function shouldIncludeFile(filename: string): boolean {
  const lower = filename.toLowerCase();
  return ACCEPTED_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

function summarizeBySchedule(files: ProcessedFile[], schedules: ScheduleConfig['schedules']): Record<string, number> {
  const summary: Record<string, number> = {};
  for (const schedule of schedules) {
    summary[schedule.id] = 0;
  }
  for (const file of files) {
    if (file.decision === 'assigned' && file.schedule) {
      summary[file.schedule] = (summary[file.schedule] ?? 0) + 1;
    }
  }
  return summary;
}

function getScheduleLabel(scheduleId: ScheduleId, schedules: ScheduleConfig['schedules']): string {
  return schedules.find((schedule) => schedule.id === scheduleId)?.label ?? scheduleId;
}

function buildBaseOutputPath(file: ProcessedFile): string {
  if (file.decision === 'duplicate') {
    return `DUPLICATES/${file.hashPrefix}/${file.name}`;
  }
  if (file.decision === 'review') {
    const candidate = file.candidate ?? 'Unknown';
    return `706/ReviewNeeded/${candidate}/${file.name}`;
  }
  return `706/${file.schedule}/${file.name}`;
}

function ensureUniqueFilename(name: string, usedNames: Set<string>): string {
  if (!usedNames.has(name)) {
    usedNames.add(name);
    return name;
  }
  const dotIndex = name.lastIndexOf('.');
  const base = dotIndex === -1 ? name : name.slice(0, dotIndex);
  const ext = dotIndex === -1 ? '' : name.slice(dotIndex);
  let counter = 1;
  let candidate = `${base}__dup${counter}${ext}`;
  while (usedNames.has(candidate)) {
    counter += 1;
    candidate = `${base}__dup${counter}${ext}`;
  }
  usedNames.add(candidate);
  return candidate;
}

function assignOutputPaths(files: ProcessedFile[]): ProcessedFile[] {
  const usedNamesByFolder = new Map<string, Set<string>>();
  return files.map((file) => {
    const basePath = buildBaseOutputPath(file);
    const segments = basePath.split('/');
    const filename = segments.pop() ?? file.name;
    const dir = segments.join('/');
    const used = usedNamesByFolder.get(dir) ?? new Set<string>();
    usedNamesByFolder.set(dir, used);
    const uniqueName = ensureUniqueFilename(filename, used);
    return {
      ...file,
      outputPath: dir.length > 0 ? `${dir}/${uniqueName}` : uniqueName,
    };
  });
}

function buildDuplicatesGroups(files: ProcessedFile[]): DuplicateGroup[] {
  const groups = new Map<string, ProcessedFile[]>();
  for (const file of files) {
    if (!groups.has(file.hash)) {
      groups.set(file.hash, []);
    }
    groups.get(file.hash)?.push(file);
  }

  const results: DuplicateGroup[] = [];
  for (const [hash, groupFiles] of groups.entries()) {
    if (groupFiles.length < 2) continue;
    const sorted = [...groupFiles].sort((a, b) => a.relativePath.localeCompare(b.relativePath));
    const kept = sorted[0];
    const duplicateNames = sorted.slice(1).map((item) => item.name);
    results.push({
      hash,
      hashPrefix: kept.hashPrefix,
      count: sorted.length,
      sourcePaths: sorted.map((item) => item.relativePath),
      keptName: kept.name,
      duplicateNames,
    });
  }
  return results;
}

function buildZipEntries(options: {
  files: ProcessedFile[];
  reportCsv: string;
  manifestJson: string;
  duplicatesCsv: string;
  sourcePaths: Record<string, string[]>;
  exportMode: ExportMode;
}): ZipFileInput[] {
  const { files, reportCsv, manifestJson, duplicatesCsv, sourcePaths, exportMode } = options;
  const entries: ZipFileInput[] = [];

  const include706 = exportMode === 'full' || exportMode === '706-only';
  const includeDuplicates = exportMode === 'full' || exportMode === 'duplicates-only';
  const includeReports = exportMode === 'full' || exportMode === 'reports-only';

  for (const file of files) {
    if (file.outputPath.startsWith('706/')) {
      if (include706) {
        entries.push({ path: file.outputPath, file: file.file });
      }
      continue;
    }
    if (file.outputPath.startsWith('DUPLICATES/')) {
      if (includeDuplicates) {
        entries.push({ path: file.outputPath, file: file.file });
      }
    }
  }

  if (includeReports) {
    entries.push({ path: 'STATE/report.csv', file: reportCsv });
    entries.push({ path: 'STATE/manifest.json', file: manifestJson });
    entries.push({ path: 'STATE/duplicates.csv', file: duplicatesCsv });

    for (const [hashPrefix, paths] of Object.entries(sourcePaths)) {
      entries.push({
        path: `STATE/_source_paths/${hashPrefix}.txt`,
        file: `${paths.join('\n')}\n`,
      });
    }
  }

  return entries;
}

function summarizeConfigDiff(prev: ScheduleConfig, next: ScheduleConfig): string {
  const prevKeywords = prev.schedules.reduce(
    (sum, schedule) => sum + schedule.keywords.length + schedule.smallTerms.length,
    0
  );
  const nextKeywords = next.schedules.reduce(
    (sum, schedule) => sum + schedule.keywords.length + schedule.smallTerms.length,
    0
  );
  const prevRules = prev.filenameRules.length;
  const nextRules = next.filenameRules.length;
  return `Schedules: ${prev.schedules.length}→${next.schedules.length}; keywords: ${prevKeywords}→${nextKeywords}; rules: ${prevRules}→${nextRules}`;
}

function hashString(value: string): string {
  let hash = 5381;
  for (let i = 0; i < value.length; i += 1) {
    hash = (hash * 33) ^ value.charCodeAt(i);
  }
  return (hash >>> 0).toString(16);
}

async function runWithConcurrency<TItem, TResult>(
  items: TItem[],
  concurrency: number,
  worker: (item: TItem, index: number) => Promise<TResult>,
  isAborted: () => boolean
): Promise<TResult[]> {
  const results: TResult[] = [];
  let currentIndex = 0;
  let active = 0;

  return new Promise((resolve) => {
    const scheduleNext = () => {
      if (isAborted() && active === 0) {
        resolve(results);
        return;
      }

      while (!isAborted() && active < concurrency && currentIndex < items.length) {
        const index = currentIndex;
        const item = items[index];
        currentIndex += 1;
        active += 1;

        worker(item, index)
          .then((result) => {
            results.push(result);
          })
          .finally(() => {
            active -= 1;
            if (currentIndex >= items.length && active === 0) {
              resolve(results);
            } else {
              scheduleNext();
            }
          });
      }

      if (currentIndex >= items.length && active === 0) {
        resolve(results);
      }
    };

    scheduleNext();
  });
}

function buildReviewClusters(files: ProcessedFile[]): Cluster[] {
  const clusters: Cluster[] = [];
  const maxTokens = 12;

  for (const file of files) {
    const tokens = normalizeText(file.textSample ?? '')
      .split(' ')
      .filter((token) => token.length > 3)
      .slice(0, maxTokens);

    if (tokens.length === 0) {
      clusters.push({ id: `cluster-${clusters.length + 1}`, tokens: [], items: [file] });
      continue;
    }

    let assigned = false;
    for (const cluster of clusters) {
      if (cluster.tokens.length === 0) continue;
      const overlap = tokens.filter((token) => cluster.tokens.includes(token));
      if (overlap.length >= 2) {
        cluster.items.push(file);
        cluster.tokens = Array.from(new Set([...cluster.tokens, ...tokens])).slice(0, maxTokens);
        assigned = true;
        break;
      }
    }

    if (!assigned) {
      clusters.push({ id: `cluster-${clusters.length + 1}`, tokens, items: [file] });
    }
  }

  return clusters;
}

async function writeEntriesToFolder(
  directoryHandle: FileSystemDirectoryHandle,
  entries: ZipFileInput[],
  isAborted: () => boolean
): Promise<void> {
  for (const entry of entries) {
    if (isAborted()) return;
    const parts = entry.path.split('/');
    const filename = parts.pop();
    if (!filename) continue;

    let currentDir = directoryHandle;
    for (const part of parts) {
      currentDir = await currentDir.getDirectoryHandle(part, { create: true });
    }

    const fileHandle = await currentDir.getFileHandle(filename, { create: true });
    const writable = await fileHandle.createWritable();
    const payload = typeof entry.file === 'string' ? new Blob([entry.file]) : entry.file;
    await writable.write(payload);
    await writable.close();
  }
}

export default function App() {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const [selectedFiles, setSelectedFiles] = useState<SelectedFile[]>([]);
  const [processedFiles, setProcessedFiles] = useState<ProcessedFile[]>([]);
  const [status, setStatus] = useState('Select a folder to begin.');
  const [isProcessing, setIsProcessing] = useState(false);
  const [sourcePaths, setSourcePaths] = useState<Record<string, string[]>>({});
  const [progressTotal, setProgressTotal] = useState(0);
  const [progressDone, setProgressDone] = useState(0);
  const [progressCurrentName, setProgressCurrentName] = useState('');
  const [isCancelled, setIsCancelled] = useState(false);
  const [concurrency, setConcurrency] = useState(2);
  const [scanThresholds, setScanThresholds] = useState<ScannedDetectionThresholds>(DEFAULT_SCAN_THRESHOLDS);
  const [exportMode, setExportMode] = useState<ExportMode>('full');
  const [debugLog, setDebugLog] = useState<string[]>([]);

  const [activeTab, setActiveTab] = useState<'sort' | 'rules'>('sort');
  const [reviewFilter, setReviewFilter] = useState<ReviewFilter>('all');
  const [reviewSearch, setReviewSearch] = useState('');

  const [scheduleConfig, setScheduleConfig] = useState<ScheduleConfig>(() =>
    loadStoredScheduleConfig() ?? getDefaultConfig()
  );
  const [rulesText, setRulesText] = useState(() => JSON.stringify(scheduleConfig, null, 2));
  const [rulesErrors, setRulesErrors] = useState<string[]>([]);
  const [rulesAuditLog, setRulesAuditLog] = useState<RulesAuditEntry[]>(() => loadRulesAuditLog());
  const [editorName, setEditorName] = useState(() => getStoredEditorName());

  const [reviewOverrides, setReviewOverrides] = useState<Record<string, ScheduleId>>(() =>
    loadReviewOverrides()
  );

  const [writeBackEnabled, setWriteBackEnabled] = useState(false);
  const [outputDirectoryHandle, setOutputDirectoryHandle] = useState<FileSystemDirectoryHandle | null>(null);

  const compiledConfig = useMemo(() => compileScheduleConfig(scheduleConfig), [scheduleConfig]);

  const summary = useMemo(() => {
    const total = processedFiles.length;
    const duplicates = processedFiles.filter((file) => file.decision === 'duplicate').length;
    const reviewNeeded = processedFiles.filter((file) => file.decision === 'review').length;
    return {
      total,
      duplicates,
      reviewNeeded,
      bySchedule: summarizeBySchedule(processedFiles, scheduleConfig.schedules),
    };
  }, [processedFiles, scheduleConfig.schedules]);

  const progressPercent = useMemo(() => {
    if (progressTotal === 0) return 0;
    return Math.round((progressDone / progressTotal) * 100);
  }, [progressDone, progressTotal]);

  const reviewItems = useMemo(() => {
    return processedFiles.filter((file) => file.decision === 'review');
  }, [processedFiles]);

  const filteredReviewItems = useMemo(() => {
    return reviewItems.filter((file) => {
      const matchesSearch = reviewSearch
        ? file.name.toLowerCase().includes(reviewSearch.toLowerCase())
        : true;
      if (!matchesSearch) return false;
      if (reviewFilter === 'all') return true;
      if (reviewFilter === 'scanned') return file.reason.startsWith('likely_scanned_pdf');
      if (reviewFilter === 'pdf_error') return file.reason.startsWith('pdf_parse_error');
      return file.reason === 'low_confidence' || file.candidate === 'Unknown';
    });
  }, [reviewItems, reviewFilter, reviewSearch]);

  const reviewClusters = useMemo(() => {
    const unknownItems = reviewItems.filter((file) => file.candidate === 'Unknown' || file.reason === 'low_confidence');
    return buildReviewClusters(unknownItems);
  }, [reviewItems]);

  const duplicateGroups = useMemo(() => buildDuplicatesGroups(processedFiles), [processedFiles]);

  const logDebug = (message: string) => {
    setDebugLog((prev) => [...prev.slice(-199), `${new Date().toLocaleTimeString()} ${message}`]);
  };

  const handlePickFolder = () => {
    inputRef.current?.click();
  };

  const handleFileSelection = (event: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files ?? []);
    const filtered = files
      .filter((file) => shouldIncludeFile(file.name))
      .map((file) => ({
        file,
        relativePath: getRelativePath(file),
      }));
    setSelectedFiles(filtered);
    setProcessedFiles([]);
    setSourcePaths({});
    setProgressTotal(filtered.length);
    setProgressDone(0);
    setProgressCurrentName('');
    setIsCancelled(false);
    setStatus(filtered.length > 0 ? `${filtered.length} file(s) ready.` : 'No supported files selected.');
  };

  const handleCancel = () => {
    abortRef.current?.abort();
    setIsCancelled(true);
    setStatus(`Cancelled at ${progressDone}/${progressTotal}.`);
  };

  const handleRunSort = async () => {
    if (selectedFiles.length === 0) {
      setStatus('Please select a folder with PDF/image files.');
      return;
    }

    const abortController = new AbortController();
    abortRef.current = abortController;
    setIsProcessing(true);
    setIsCancelled(false);
    setProgressTotal(selectedFiles.length);
    setProgressDone(0);
    setProgressCurrentName('');
    setStatus('Processing files...');
    setDebugLog([]);

    const processed: ProcessedFile[] = [];
    const seenHashes = new Map<string, ProcessedFile>();
    const sourcePathsMap: Record<string, string[]> = {};

    const isAborted = () => abortController.signal.aborted;

    try {
      await runWithConcurrency(
        selectedFiles,
        concurrency,
        async (item, index) => {
          if (isAborted()) {
            return undefined;
          }

          setProgressCurrentName(item.relativePath);
          logDebug(`Start ${index + 1}/${selectedFiles.length}: ${item.relativePath}`);

          try {
            const buffer = await item.file.arrayBuffer();
            const hash = await hashArrayBuffer(buffer);
            const hashPrefix = getHashPrefix(hash);

            if (!sourcePathsMap[hashPrefix]) {
              sourcePathsMap[hashPrefix] = [];
            }
            sourcePathsMap[hashPrefix].push(item.relativePath);

            if (seenHashes.has(hash)) {
              const duplicate = seenHashes.get(hash);
              const duplicateEntry: ProcessedFile = {
                file: item.file,
                name: item.file.name,
                relativePath: item.relativePath,
                size: item.file.size,
                type: item.file.type,
                hash,
                hashPrefix,
                decision: 'duplicate',
                schedule: duplicate?.schedule,
                candidate: duplicate?.candidate,
                reason: 'sha256_duplicate',
                score: duplicate?.score ?? 0,
                outputPath: '',
                scores: duplicate?.scores ?? ({} as Record<ScheduleId, number>),
              };
              processed.push(duplicateEntry);
              logDebug(`Duplicate detected for ${item.relativePath}`);
              return duplicateEntry;
            }

            const overrideSchedule = reviewOverrides[hash];
            if (overrideSchedule) {
              const scores = {} as Record<ScheduleId, number>;
              for (const schedule of compiledConfig.schedules) {
                scores[schedule.id] = schedule.id === overrideSchedule ? SCORE_FLOOR : 0;
              }
              const overrideEntry: ProcessedFile = {
                file: item.file,
                name: item.file.name,
                relativePath: item.relativePath,
                size: item.file.size,
                type: item.file.type,
                hash,
                hashPrefix,
                decision: 'assigned',
                schedule: overrideSchedule,
                reason: 'review_override',
                score: SCORE_FLOOR,
                outputPath: '',
                scores,
                overrideApplied: true,
              };
              processed.push(overrideEntry);
              seenHashes.set(hash, overrideEntry);
              logDebug(`Applied override for ${item.relativePath} → ${overrideSchedule}`);
              return overrideEntry;
            }

            let text = '';
            let pdfMetrics: PdfTextResult | undefined;
            const pdf = isPdfFile(item.file.name);
            if (pdf) {
              try {
                pdfMetrics = await extractPdfText(buffer);
                text = pdfMetrics.text;
              } catch (error) {
                const errorEntry: ProcessedFile = {
                  file: item.file,
                  name: item.file.name,
                  relativePath: item.relativePath,
                  size: item.file.size,
                  type: item.file.type,
                  hash,
                  hashPrefix,
                  decision: 'review',
                  candidate: 'Unknown',
                  reason: `pdf_parse_error: ${String(error)}`,
                  score: 0,
                  outputPath: '',
                  scores: {} as Record<ScheduleId, number>,
                };
                processed.push(errorEntry);
                seenHashes.set(hash, errorEntry);
                logDebug(`PDF parse error for ${item.relativePath}: ${String(error)}`);
                return errorEntry;
              }
            }

            const classification = classifyDocument({
              filename: item.file.name,
              text,
              isPdf: pdf,
              config: compiledConfig,
              pdfMetrics,
              scannedThresholds: scanThresholds,
            });

            const entry: ProcessedFile = {
              file: item.file,
              name: item.file.name,
              relativePath: item.relativePath,
              size: item.file.size,
              type: item.file.type,
              hash,
              hashPrefix,
              decision: classification.decision,
              schedule: classification.schedule,
              candidate: classification.candidate,
              reason: classification.reason,
              score: classification.score,
              outputPath: '',
              scores: classification.scores,
              pdfMetrics,
              textSample: classification.decision === 'review' ? text.slice(0, 200) : undefined,
            };

            processed.push(entry);
            seenHashes.set(hash, entry);
            logDebug(`Finished ${item.relativePath} (${classification.reason})`);
            return entry;
          } catch (error) {
            const fallbackHash = `error-${index}`;
            const fallbackPrefix = getHashPrefix(fallbackHash);
            const errorEntry: ProcessedFile = {
              file: item.file,
              name: item.file.name,
              relativePath: item.relativePath,
              size: item.file.size,
              type: item.file.type,
              hash: fallbackHash,
              hashPrefix: fallbackPrefix,
              decision: 'review',
              candidate: 'Unknown',
              reason: `processing_error: ${String(error)}`,
              score: 0,
              outputPath: '',
              scores: {} as Record<ScheduleId, number>,
            };
            processed.push(errorEntry);
            logDebug(`Processing error for ${item.relativePath}: ${String(error)}`);
            return errorEntry;
          } finally {
            setProgressDone((prev) => prev + 1);
          }
        },
        isAborted
      );

      const withPaths = assignOutputPaths(processed);
      setProcessedFiles(withPaths);
      setSourcePaths(sourcePathsMap);

      const completedCount = processed.length;
      if (isAborted()) {
        setStatus(`Cancelled at ${completedCount}/${selectedFiles.length}.`);
      } else {
        setStatus('Sorting complete.');
      }
    } catch (error) {
      setStatus(`Processing failed: ${String(error)}`);
    } finally {
      setIsProcessing(false);
      setProgressCurrentName('');
      abortRef.current = null;
    }
  };

  const buildReports = () => {
    const rows = [
      [
        'name',
        'relative_path',
        'output_path',
        'decision',
        'schedule',
        'candidate',
        'reason',
        'score',
        'hash',
      ],
    ];

    for (const file of processedFiles) {
      rows.push([
        file.name,
        file.relativePath,
        file.outputPath,
        file.decision,
        file.schedule ?? '',
        file.candidate ?? '',
        file.reason,
        String(file.score),
        file.hash,
      ]);
    }

    const reportCsv = buildCsv(rows);

    const duplicateGroups = buildDuplicatesGroups(processedFiles);
    const duplicateRows = [
      ['hashPrefix', 'count', 'source_relative_paths', 'kept_name', 'duplicate_names'],
      ...duplicateGroups.map((group) => [
        group.hashPrefix,
        String(group.count),
        group.sourcePaths.join(' | '),
        group.keptName,
        group.duplicateNames.join(' | '),
      ]),
    ];
    const duplicatesCsv = buildCsv(duplicateRows);

    const manifestFiles = processedFiles.map(({ file, ...rest }) => rest);
    const manifestJson = JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        totals: summary,
        config: scheduleConfig,
        thresholds: scanThresholds,
        files: manifestFiles,
      },
      null,
      2
    );
    return { reportCsv, manifestJson, duplicatesCsv };
  };

  const buildEntries = () => {
    const { reportCsv, manifestJson, duplicatesCsv } = buildReports();
    return buildZipEntries({
      files: processedFiles,
      reportCsv,
      manifestJson,
      duplicatesCsv,
      sourcePaths,
      exportMode,
    });
  };

  const handleDownloadZip = async () => {
    if (processedFiles.length === 0) {
      setStatus('Run the sort before downloading.');
      return;
    }
    setStatus('Building ZIP...');
    const entries = buildEntries();
    const blob = await buildZip(entries);
    const suffix =
      exportMode === 'reports-only'
        ? 'reports'
        : exportMode === '706-only'
          ? '706'
          : exportMode === 'duplicates-only'
            ? 'duplicates'
            : 'sorted';
    downloadBlob(blob, `estate-706-${suffix}.zip`);
    setStatus('ZIP ready.');
  };

  const handleWriteOutput = async () => {
    if (processedFiles.length === 0) {
      setStatus('Run the sort before writing output.');
      return;
    }
    if (!outputDirectoryHandle) {
      setStatus('Choose an output folder first.');
      return;
    }
    setStatus('Writing to output folder...');
    const entries = buildEntries();
    const isAborted = () => abortRef.current?.signal.aborted ?? false;
    await writeEntriesToFolder(outputDirectoryHandle, entries, isAborted);
    setStatus('Output folder ready.');
  };

  const handlePickOutputFolder = async () => {
    if (!('showDirectoryPicker' in window)) {
      setStatus('File System Access API not available in this browser.');
      return;
    }
    try {
      const handle = await (window as Window & { showDirectoryPicker: () => Promise<FileSystemDirectoryHandle> })
        .showDirectoryPicker();
      setOutputDirectoryHandle(handle);
      setStatus('Output folder selected.');
    } catch (error) {
      setStatus(`Output folder selection cancelled: ${String(error)}`);
    }
  };

  const handleSaveRules = () => {
    try {
      const parsed = JSON.parse(rulesText) as ScheduleConfig;
      const { config, errors } = validateScheduleConfig(parsed);
      if (!config || errors.length > 0) {
        setRulesErrors(errors.length > 0 ? errors : ['Invalid JSON structure.']);
        return;
      }

      const prevConfig = scheduleConfig;
      const prevHash = hashString(JSON.stringify(prevConfig));
      const nextHash = hashString(JSON.stringify(config));
      saveScheduleConfig(config);
      setScheduleConfig(config);
      setRulesErrors([]);

      const summary = summarizeConfigDiff(prevConfig, config);
      const entry: RulesAuditEntry = {
        timestamp: new Date().toISOString(),
        editorName: editorName || undefined,
        summary,
        beforeHash: prevHash,
        afterHash: nextHash,
      };
      appendRulesAuditEntry(entry);
      setRulesAuditLog((prev) => [entry, ...prev]);
      setStatus('Rules saved to local storage.');
    } catch (error) {
      setRulesErrors([`Invalid JSON: ${String(error)}`]);
    }
  };

  const handleResetRules = () => {
    const defaults = getDefaultConfig();
    resetStoredScheduleConfig();
    setScheduleConfig(defaults);
    setRulesText(JSON.stringify(defaults, null, 2));
    setRulesErrors([]);
    setStatus('Rules reset to defaults.');
  };

  const handleExportRules = () => {
    const blob = new Blob([JSON.stringify(scheduleConfig, null, 2)], { type: 'application/json' });
    downloadBlob(blob, 'estate-706-rules.json');
  };

  const handleImportRules = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    const text = await file.text();
    setRulesText(text);
    setRulesErrors([]);
  };

  const handleEditorNameChange = (value: string) => {
    setEditorName(value);
    setStoredEditorName(value);
  };

  const handleOverrideChange = (hash: string, scheduleId: ScheduleId | 'clear') => {
    const updated = { ...reviewOverrides };
    if (scheduleId === 'clear') {
      delete updated[hash];
    } else {
      updated[hash] = scheduleId;
    }
    setReviewOverrides(updated);
    saveReviewOverrides(updated);

    const recalculated = assignOutputPaths(
      processedFiles.map((file) => {
        if (file.hash !== hash) return file;
        if (scheduleId === 'clear') {
          return { ...file, overrideApplied: false };
        }
        return {
          ...file,
          decision: 'assigned',
          schedule: scheduleId,
          candidate: undefined,
          reason: 'review_override',
          score: SCORE_FLOOR,
          overrideApplied: true,
        };
      })
    );
    setProcessedFiles(recalculated);
  };

  const totalFilesLabel = `${progressDone}/${progressTotal}`;
  const cancelLabel = isCancelled ? ' (Cancelled)' : '';

  return (
    <div className="app">
      <header>
        <h1>706 Schedule Sorter</h1>
        <p>Runs entirely in your browser. No uploads. No analytics.</p>
      </header>

      <nav className="tabs">
        <button
          type="button"
          className={activeTab === 'sort' ? 'tab active' : 'tab'}
          onClick={() => setActiveTab('sort')}
        >
          Sorting
        </button>
        <button
          type="button"
          className={activeTab === 'rules' ? 'tab active' : 'tab'}
          onClick={() => setActiveTab('rules')}
        >
          Rules
        </button>
      </nav>

      {activeTab === 'sort' && (
        <>
          <section className="controls">
            <input
              ref={inputRef}
              type="file"
              multiple
              // @ts-expect-error webkitdirectory is supported in Chromium-based browsers.
              webkitdirectory="true"
              onChange={handleFileSelection}
              className="hidden"
            />
            <button type="button" onClick={handlePickFolder} disabled={isProcessing}>
              1. Pick Folder
            </button>
            <button type="button" onClick={handleRunSort} disabled={isProcessing || selectedFiles.length === 0}>
              2. Run Sort
            </button>
            <button type="button" onClick={handleDownloadZip} disabled={processedFiles.length === 0}>
              3. Download Export
            </button>
            {isProcessing && (
              <button type="button" className="danger" onClick={handleCancel}>
                Cancel
              </button>
            )}
          </section>

          <section className="status">
            <strong>Status:</strong> {status}
          </section>

          <section className="progress">
            <div className="progress-header">
              <div>
                <strong>
                  Processing {totalFilesLabel}
                  {cancelLabel}
                </strong>{' '}
                ({progressPercent}%)
              </div>
              <div className="progress-current">Current: {progressCurrentName || '—'}</div>
            </div>
            <div className="progress-bar">
              <div className="progress-bar-fill" style={{ width: `${progressPercent}%` }} />
            </div>
          </section>

          <section className="export-options">
            <h2>Export Options</h2>
            <div className="export-grid">
              <label>
                Export format
                <select
                  value={exportMode}
                  onChange={(event) => setExportMode(event.target.value as ExportMode)}
                >
                  <option value="full">Full ZIP (706 + DUPLICATES + STATE)</option>
                  <option value="706-only">ZIP: 706 only</option>
                  <option value="duplicates-only">ZIP: DUPLICATES only</option>
                  <option value="reports-only">Reports only (CSV/JSON/duplicates.csv)</option>
                </select>
              </label>
              <label>
                Concurrency
                <select
                  value={concurrency}
                  onChange={(event) => setConcurrency(Number(event.target.value))}
                  disabled={isProcessing}
                >
                  {[1, 2, 3, 4].map((value) => (
                    <option key={value} value={value}>
                      {value}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <div className="advanced">
              <h3>Advanced</h3>
              <div className="advanced-grid">
                <label>
                  PDF minimum characters
                  <input
                    type="number"
                    min={0}
                    value={scanThresholds.minChars}
                    onChange={(event) =>
                      setScanThresholds((prev) => ({
                        ...prev,
                        minChars: Number(event.target.value),
                      }))
                    }
                  />
                </label>
                <label>
                  PDF minimum text items
                  <input
                    type="number"
                    min={0}
                    value={scanThresholds.minTextItems}
                    onChange={(event) =>
                      setScanThresholds((prev) => ({
                        ...prev,
                        minTextItems: Number(event.target.value),
                      }))
                    }
                  />
                </label>
                <label className="checkbox">
                  <input
                    type="checkbox"
                    checked={writeBackEnabled}
                    onChange={(event) => setWriteBackEnabled(event.target.checked)}
                  />
                  Enable File System Access API write-back (Chromium only)
                </label>
              </div>
              {writeBackEnabled && (
                <div className="write-back">
                  <button type="button" onClick={handlePickOutputFolder}>
                    Choose Output Folder
                  </button>
                  <button type="button" onClick={handleWriteOutput} disabled={!outputDirectoryHandle}>
                    Write Output Folder
                  </button>
                  <span className="write-back-note">
                    Output folder: {outputDirectoryHandle ? 'Selected' : 'Not selected'}
                  </span>
                </div>
              )}
            </div>
          </section>

          <section className="summary">
            <h2>Summary</h2>
            <div className="summary-grid">
              <div>
                <div className="summary-label">Total files</div>
                <div className="summary-value">{summary.total}</div>
              </div>
              <div>
                <div className="summary-label">Duplicates</div>
                <div className="summary-value">{summary.duplicates}</div>
              </div>
              <div>
                <div className="summary-label">Review needed</div>
                <div className="summary-value">{summary.reviewNeeded}</div>
              </div>
            </div>
            <div className="schedule-summary">
              {scheduleConfig.schedules.map((schedule) => (
                <div key={schedule.id} className="schedule-card">
                  <div className="schedule-title">{getScheduleLabel(schedule.id, scheduleConfig.schedules)}</div>
                  <div className="schedule-count">{summary.bySchedule[schedule.id] ?? 0}</div>
                </div>
              ))}
            </div>
          </section>

          <section className="review-panel">
            <h2>Review Needed</h2>
            <div className="review-controls">
              <div className="filters">
                {([
                  ['all', 'All review'],
                  ['scanned', 'Likely scanned'],
                  ['pdf_error', 'PDF parse error'],
                  ['low_confidence', 'Unknown / low confidence'],
                ] as const).map(([value, label]) => (
                  <button
                    key={value}
                    type="button"
                    className={reviewFilter === value ? 'filter active' : 'filter'}
                    onClick={() => setReviewFilter(value)}
                  >
                    {label}
                  </button>
                ))}
              </div>
              <input
                type="search"
                placeholder="Search filename..."
                value={reviewSearch}
                onChange={(event) => setReviewSearch(event.target.value)}
              />
            </div>
            {filteredReviewItems.length === 0 ? (
              <p>No review items for the current filter.</p>
            ) : (
              <div className="table-wrapper">
                <table>
                  <thead>
                    <tr>
                      <th>File name</th>
                      <th>Candidate schedule</th>
                      <th>Reason</th>
                      <th>Score</th>
                      <th>Source path</th>
                      <th>Override</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredReviewItems.map((file) => (
                      <tr key={file.relativePath}>
                        <td>{file.name}</td>
                        <td>{file.candidate ?? 'Unknown'}</td>
                        <td>{file.reason}</td>
                        <td>{file.score}</td>
                        <td>{file.relativePath}</td>
                        <td>
                          <select
                            value={reviewOverrides[file.hash] ?? 'none'}
                            onChange={(event) =>
                              handleOverrideChange(
                                file.hash,
                                event.target.value === 'none'
                                  ? 'clear'
                                  : (event.target.value as ScheduleId)
                              )
                            }
                          >
                            <option value="none">No override</option>
                            {scheduleConfig.schedules.map((schedule) => (
                              <option key={schedule.id} value={schedule.id}>
                                {getScheduleLabel(schedule.id, scheduleConfig.schedules)}
                              </option>
                            ))}
                          </select>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            <div className="clusters">
              <h3>Unknown clusters</h3>
              {reviewClusters.length === 0 ? (
                <p>No clusters yet.</p>
              ) : (
                <div className="cluster-grid">
                  {reviewClusters.map((cluster) => (
                    <div key={cluster.id} className="cluster-card">
                      <div className="cluster-title">
                        {cluster.tokens.length > 0 ? cluster.tokens.join(', ') : 'No terms'}
                      </div>
                      <div className="cluster-count">{cluster.items.length} file(s)</div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </section>

          <section className="duplicates">
            <h2>Duplicates</h2>
            {duplicateGroups.length === 0 ? (
              <p>No duplicates detected.</p>
            ) : (
              <div className="duplicate-list">
                {duplicateGroups.map((group) => (
                  <details key={group.hash}>
                    <summary>
                      {group.hashPrefix} — {group.count} files (kept: {group.keptName})
                    </summary>
                    <div className="duplicate-details">
                      <div>
                        <strong>Sources:</strong> {group.sourcePaths.join(', ')}
                      </div>
                      <div>
                        <strong>Duplicates:</strong> {group.duplicateNames.join(', ')}
                      </div>
                    </div>
                  </details>
                ))}
              </div>
            )}
          </section>

          <section className="file-list">
            <h2>Selected Files</h2>
            {selectedFiles.length === 0 ? (
              <p>No files selected yet.</p>
            ) : (
              <ul>
                {selectedFiles.map((item) => (
                  <li key={item.relativePath}>{item.relativePath}</li>
                ))}
              </ul>
            )}
          </section>

          <section className="debug-log">
            <details>
              <summary>Show debug log</summary>
              <pre>{debugLog.join('\n')}</pre>
            </details>
          </section>
        </>
      )}

      {activeTab === 'rules' && (
        <section className="rules">
          <h2>Rules Editor</h2>
          <p>Edit the schedules and filename rules JSON. Saved rules are stored locally in this browser.</p>
          <label>
            Editor name (optional)
            <input
              type="text"
              value={editorName}
              onChange={(event) => handleEditorNameChange(event.target.value)}
              placeholder="e.g., Jamie"
            />
          </label>
          <textarea value={rulesText} onChange={(event) => setRulesText(event.target.value)} rows={18} />
          {rulesErrors.length > 0 && (
            <div className="error">
              <strong>Fix before saving:</strong>
              <ul>
                {rulesErrors.map((error) => (
                  <li key={error}>{error}</li>
                ))}
              </ul>
            </div>
          )}
          <div className="rules-actions">
            <button type="button" onClick={handleSaveRules}>
              Save Rules
            </button>
            <button type="button" onClick={handleResetRules}>
              Reset to Defaults
            </button>
            <button type="button" onClick={handleExportRules}>
              Export Rules JSON
            </button>
            <label className="import">
              Import Rules JSON
              <input type="file" accept="application/json" onChange={handleImportRules} />
            </label>
          </div>

          <div className="audit-log">
            <h3>Rules audit trail</h3>
            {rulesAuditLog.length === 0 ? (
              <p>No saved changes yet.</p>
            ) : (
              <div className="table-wrapper">
                <table>
                  <thead>
                    <tr>
                      <th>Timestamp</th>
                      <th>Editor</th>
                      <th>Summary</th>
                      <th>Before</th>
                      <th>After</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rulesAuditLog.map((entry) => (
                      <tr key={`${entry.timestamp}-${entry.afterHash}`}>
                        <td>{new Date(entry.timestamp).toLocaleString()}</td>
                        <td>{entry.editorName ?? '—'}</td>
                        <td>{entry.summary}</td>
                        <td>{entry.beforeHash}</td>
                        <td>{entry.afterHash}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </section>
      )}
    </div>
  );
}
