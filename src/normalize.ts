export function normalizeText(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function countTermOccurrences(text: string, term: string): number {
  if (!text || !term) {
    return 0;
  }
  const normalizedText = normalizeText(text);
  const normalizedTerm = normalizeText(term);
  if (!normalizedTerm) {
    return 0;
  }
  let count = 0;
  let index = normalizedText.indexOf(normalizedTerm);
  while (index !== -1) {
    count += 1;
    index = normalizedText.indexOf(normalizedTerm, index + normalizedTerm.length);
  }
  return count;
}
