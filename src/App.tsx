import { useMemo, useRef, useState } from 'react';
import './App.css';
import { classifyDocument, getScheduleLabel } from './classify';
import { hashArrayBuffer } from './hash';
import { extractPdfText } from './pdfText';
import { type ScheduleId, SCHEDULES } from './schedules';
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
}

const ACCEPTED_EXTENSIONS = ['.pdf', '.png', '.jpg', '.jpeg', '.tiff', '.tif'];

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

function summarizeBySchedule(files: ProcessedFile[]): Record<ScheduleId, number> {
  const summary = {} as Record<ScheduleId, number>;
  for (const schedule of SCHEDULES) {
    summary[schedule.id] = 0;
  }
  for (const file of files) {
    if (file.decision === 'assigned' && file.schedule) {
      summary[file.schedule] += 1;
    }
  }
  return summary;
}

function buildZipEntries(files: ProcessedFile[], reportCsv: string, manifestJson: string) {
  const entries: ZipFileInput[] = [];
  const sourcePathsByHash: Record<string, string[]> = {};

  for (const file of files) {
    entries.push({ path: file.outputPath, file: file.file });
    if (!sourcePathsByHash[file.hashPrefix]) {
      sourcePathsByHash[file.hashPrefix] = [];
    }
    sourcePathsByHash[file.hashPrefix].push(file.relativePath);
  }

  for (const [hashPrefix, paths] of Object.entries(sourcePathsByHash)) {
    entries.push({
      path: `STATE/_source_paths/${hashPrefix}.txt`,
      file: `${paths.join('\n')}\n`,
    });
  }

  entries.push({ path: 'STATE/report.csv', file: reportCsv });
  entries.push({ path: 'STATE/manifest.json', file: manifestJson });
  return entries;
}

function buildReportsOnlyEntries(reportCsv: string, manifestJson: string, sourcePaths: Record<string, string[]>) {
  const entries: ZipFileInput[] = [
    { path: 'STATE/report.csv', file: reportCsv },
    { path: 'STATE/manifest.json', file: manifestJson },
  ];

  for (const [hashPrefix, paths] of Object.entries(sourcePaths)) {
    entries.push({ path: `STATE/_source_paths/${hashPrefix}.txt`, file: `${paths.join('\n')}\n` });
  }

  return entries;
}

function buildOutputPath(file: ProcessedFile): string {
  if (file.decision === 'duplicate') {
    return `DUPLICATES/${file.hashPrefix}/${file.name}`;
  }
  if (file.decision === 'review') {
    const candidate = file.candidate ?? 'Unknown';
    return `706/ReviewNeeded/${candidate}/${file.name}`;
  }
  return `706/${file.schedule}/${file.name}`;
}

export default function App() {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [selectedFiles, setSelectedFiles] = useState<SelectedFile[]>([]);
  const [processedFiles, setProcessedFiles] = useState<ProcessedFile[]>([]);
  const [status, setStatus] = useState('Select a folder to begin.');
  const [isProcessing, setIsProcessing] = useState(false);
  const [sourcePaths, setSourcePaths] = useState<Record<string, string[]>>({});

  const summary = useMemo(() => {
    const total = processedFiles.length;
    const duplicates = processedFiles.filter((file) => file.decision === 'duplicate').length;
    const reviewNeeded = processedFiles.filter((file) => file.decision === 'review').length;
    return {
      total,
      duplicates,
      reviewNeeded,
      bySchedule: summarizeBySchedule(processedFiles),
    };
  }, [processedFiles]);

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
    setStatus(filtered.length > 0 ? `${filtered.length} file(s) ready.` : 'No supported files selected.');
  };

  const handleRunSort = async () => {
    if (selectedFiles.length === 0) {
      setStatus('Please select a folder with PDF/image files.');
      return;
    }
    setIsProcessing(true);
    setStatus('Processing files...');

    const processed: ProcessedFile[] = [];
    const seenHashes = new Map<string, ProcessedFile>();
    const sourcePathsMap: Record<string, string[]> = {};

    for (const item of selectedFiles) {
      const { file, relativePath } = item;
      const buffer = await file.arrayBuffer();
      const hash = await hashArrayBuffer(buffer);
      const hashPrefix = getHashPrefix(hash);

      if (!sourcePathsMap[hashPrefix]) {
        sourcePathsMap[hashPrefix] = [];
      }
      sourcePathsMap[hashPrefix].push(relativePath);

      if (seenHashes.has(hash)) {
        const duplicate = seenHashes.get(hash);
        const duplicateEntry: ProcessedFile = {
          file,
          name: file.name,
          relativePath,
          size: file.size,
          type: file.type,
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
        duplicateEntry.outputPath = buildOutputPath(duplicateEntry);
        processed.push(duplicateEntry);
        continue;
      }

      let text = '';
      const pdf = isPdfFile(file.name);
      if (pdf) {
        text = await extractPdfText(buffer);
      }

      const classification = classifyDocument({
        filename: file.name,
        text,
        isPdf: pdf,
      });

      const entry: ProcessedFile = {
        file,
        name: file.name,
        relativePath,
        size: file.size,
        type: file.type,
        hash,
        hashPrefix,
        decision: classification.decision,
        schedule: classification.schedule,
        candidate: classification.candidate,
        reason: classification.reason,
        score: classification.score,
        outputPath: '',
        scores: classification.scores,
      };
      entry.outputPath = buildOutputPath(entry);
      processed.push(entry);
      seenHashes.set(hash, entry);
    }

    setProcessedFiles(processed);
    setSourcePaths(sourcePathsMap);
    setStatus('Sorting complete.');
    setIsProcessing(false);
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
    const manifestFiles = processedFiles.map(({ file, ...rest }) => rest);
    const manifestJson = JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        totals: summary,
        files: manifestFiles,
      },
      null,
      2
    );
    return { reportCsv, manifestJson };
  };

  const handleDownloadZip = async () => {
    if (processedFiles.length === 0) {
      setStatus('Run the sort before downloading.');
      return;
    }
    setStatus('Building ZIP...');
    const { reportCsv, manifestJson } = buildReports();

    const reportEntries = buildZipEntries(processedFiles, reportCsv, manifestJson);
    const blob = await buildZip(reportEntries);
    downloadBlob(blob, 'estate-706-sorted.zip');
    setStatus('ZIP ready.');
  };

  const handleDownloadReports = async () => {
    if (processedFiles.length === 0) {
      setStatus('Run the sort before downloading reports.');
      return;
    }
    setStatus('Building reports ZIP...');
    const { reportCsv, manifestJson } = buildReports();
    const entries = buildReportsOnlyEntries(reportCsv, manifestJson, sourcePaths);
    const blob = await buildZip(entries);
    downloadBlob(blob, 'estate-706-reports.zip');
    setStatus('Reports ZIP ready.');
  };

  return (
    <div className="app">
      <header>
        <h1>706 Schedule Sorter</h1>
        <p>Runs entirely in your browser. No uploads. No analytics.</p>
      </header>

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
          3. Download ZIP
        </button>
        <button type="button" onClick={handleDownloadReports} disabled={processedFiles.length === 0}>
          4. Download Reports Only
        </button>
      </section>

      <section className="status">
        <strong>Status:</strong> {status}
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
          {SCHEDULES.map((schedule) => (
            <div key={schedule.id} className="schedule-card">
              <div className="schedule-title">{getScheduleLabel(schedule.id)}</div>
              <div className="schedule-count">{summary.bySchedule[schedule.id]}</div>
            </div>
          ))}
        </div>
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
    </div>
  );
}
