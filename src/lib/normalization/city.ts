import { normalizeSearchText } from "./text";

const CITY_ALIASES: Record<string, string> = {
  "bogota": "Bogotá",
  "bogota d.c.": "Bogotá",
  "bogota dc": "Bogotá",
  "medellin": "Medellín",
  "rio negro": "Rionegro",
  "rionegro": "Rionegro",
  "sta marta": "Santa Marta",
  "santa marta": "Santa Marta",
  "b/quilla": "Barranquilla",
  "barranquilla": "Barranquilla",
  "cartagena": "Cartagena",
  "monteria": "Montería",
  "bello": "Bello",
  "itagui": "Itagüí",
  "soacha": "Soacha",
  "soledad": "Soledad"
};

export function normalizeCity(value: string | null | undefined): string | null {
  const key = normalizeSearchText(value);
  if (!key) return null;
  return CITY_ALIASES[key] ?? value!.trim().replace(/\s+/g, " ");
}
