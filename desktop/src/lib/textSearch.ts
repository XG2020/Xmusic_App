export function matchesText(query: string, values: (string | undefined)[]): boolean {
  const normalized = (value: string) => value.normalize('NFKC').toLocaleLowerCase();
  const terms = normalized(query).trim().split(/\s+/).filter(Boolean);
  const haystack = normalized(values.filter(Boolean).join(' '));
  return terms.every(term => haystack.includes(term));
}
