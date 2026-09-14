export function stripAccents(value: string): string {
  return value.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

export function normalizeWhitespace(value: string | null | undefined): string | null {
  if (!value) return null;
  const normalized = value.trim().replace(/\s+/g, " ");
  return normalized || null;
}

export function normalizeSearchText(value: string | null | undefined): string | null {
  const trimmed = normalizeWhitespace(value);
  if (!trimmed) return null;
  return stripAccents(trimmed).toLowerCase();
}
