// Fuzzy title matching must not erase the identifiers of a grant installment.
export function compatiblePaymentTitles(application: string, project: string) {
  const normalized = (value: string) => value.toLowerCase().replace(/[–—]/gu, "-");
  const left = normalized(application);
  const right = normalized(project);
  const markers = [
    /\bphase\s*[-:]?\s*(\d+|[ivx]+)\b/gu,
    /\bq([1-4])\b/gu,
    /\b(20\d{2})\b/gu
  ];
  for (const pattern of markers) {
    const a = new Set([...left.matchAll(pattern)].map((match) => match[1]));
    const b = new Set([...right.matchAll(pattern)].map((match) => match[1]));
    if (a.size && b.size && ![...a].some((value) => b.has(value))) return false;
  }
  // A ledger explicitly marked revised cannot belong to the original proposal.
  if (/\brevised\b/u.test(right) && !/\brevised\b/u.test(left)) return false;
  return true;
}
