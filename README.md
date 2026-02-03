# 706 Schedule Sorter

A lightweight, client-side tool for sorting estate documents into IRS Form 706 schedules. It runs entirely in the browser and never uploads files anywhere.

## What it does

- Lets you pick a **folder** of PDFs and images (including nested folders).
- Classifies each file into a 706 schedule folder using filename rules and PDF embedded text extraction.
- Flags low-confidence classifications and likely scanned PDFs into **ReviewNeeded**.
- Detects duplicates using SHA-256 hashing.
- Generates a downloadable ZIP with the expected folder structure plus reports.

## Privacy statement

All processing happens locally in your browser. The app does **not** upload files, call external APIs, or include analytics/telemetry.

## Recommended browser

Use Chrome or Edge for the best folder-picking support (via `webkitdirectory`).

## Scanned PDFs

This version does **not** run OCR. If a PDF has too little embedded text, it is routed to `706/ReviewNeeded/Unknown/` with a note that OCR is required.

## Run locally

```bash
npm install
npm run dev
```

Build for production:

```bash
npm run build
```

## Reports

The ZIP includes:

- `STATE/report.csv` – summary table of each file.
- `STATE/manifest.json` – full JSON snapshot for auditing.
- `STATE/_source_paths/<hashprefix>.txt` – list of original source paths per hash.
