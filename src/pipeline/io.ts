import { readFile } from "node:fs/promises";
import { parse } from "csv-parse/sync";

export async function readCsv<T>(path: string): Promise<T[]> {
  const content = await readFile(path, "utf8");
  return parse(content, { columns: true, skip_empty_lines: true, bom: true, relax_column_count: true }) as T[];
}

export async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T;
}
