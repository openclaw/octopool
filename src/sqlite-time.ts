export function sqliteTimestamp(value: Date | number): string {
  return new Date(value).toISOString().replace("T", " ").slice(0, 19);
}

export function parseSQLiteTimestamp(value: string): number {
  return Date.parse(value.endsWith("Z") ? value : `${value.replace(" ", "T")}Z`);
}
