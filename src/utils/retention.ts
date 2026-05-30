import fs from 'fs';
import path from 'path';

export const DEFAULT_RETENTION_KEEP_COUNT = 3;

const TIMESTAMP_PATTERN = '\\d{4}-\\d{2}-\\d{2}_\\d{2}-\\d{2}-\\d{2}';
const PURE_TIMESTAMP_RE = new RegExp(`^${TIMESTAMP_PATTERN}$`);
const SEGMENTED_TIMESTAMP_RE = new RegExp(`^(.*)_(${TIMESTAMP_PATTERN})$`);
const DEFAULT_SEGMENT = '__default__';

interface TimestampedEntry {
  segment: string;
  timestamp: string;
}

export function isTimestampedRunName(name: string): boolean {
  return parseTimestampedDirectoryName(name) !== null;
}

export async function pruneTimestampedFilesBySegment(
  dirPath: string,
  keepCount: number = DEFAULT_RETENTION_KEEP_COUNT,
): Promise<void> {
  const entries = await readDirectoryEntries(dirPath);
  if (!entries) {
    return;
  }

  const groupedPaths = new Map<string, Map<string, string[]>>();
  for (const entry of entries) {
    if (!entry.isFile()) {
      continue;
    }

    const parsed = parseTimestampedFileName(entry.name);
    if (!parsed) {
      continue;
    }

    const segmentEntries = groupedPaths.get(parsed.segment) ?? new Map<string, string[]>();
    const timestampEntries = segmentEntries.get(parsed.timestamp) ?? [];
    timestampEntries.push(path.join(dirPath, entry.name));
    segmentEntries.set(parsed.timestamp, timestampEntries);
    groupedPaths.set(parsed.segment, segmentEntries);
  }

  const removablePaths = collectRemovablePaths(groupedPaths, keepCount);
  if (removablePaths.length === 0) {
    return;
  }

  await Promise.all(removablePaths.map(async (filePath) => {
    await fs.promises.rm(filePath, { force: true }).catch(() => undefined);
  }));

  console.log(`[Retention] output prune: ${removablePaths.length} files removed from ${path.resolve(dirPath)}`);
}

export async function pruneTimestampedChildDirectories(
  dirPath: string,
  keepCount: number = DEFAULT_RETENTION_KEEP_COUNT,
): Promise<void> {
  const entries = await readDirectoryEntries(dirPath);
  if (!entries) {
    return;
  }

  const groupedPaths = new Map<string, Map<string, string[]>>();
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }

    const parsed = parseTimestampedDirectoryName(entry.name);
    if (!parsed) {
      continue;
    }

    const segmentEntries = groupedPaths.get(parsed.segment) ?? new Map<string, string[]>();
    const timestampEntries = segmentEntries.get(parsed.timestamp) ?? [];
    timestampEntries.push(path.join(dirPath, entry.name));
    segmentEntries.set(parsed.timestamp, timestampEntries);
    groupedPaths.set(parsed.segment, segmentEntries);
  }

  const removablePaths = collectRemovablePaths(groupedPaths, keepCount);
  if (removablePaths.length === 0) {
    return;
  }

  await Promise.all(removablePaths.map(async (entryPath) => {
    await fs.promises.rm(entryPath, { recursive: true, force: true }).catch(() => undefined);
  }));

  console.log(`[Retention] artifact prune: ${removablePaths.length} directories removed from ${path.resolve(dirPath)}`);
}

function collectRemovablePaths(
  groupedPaths: Map<string, Map<string, string[]>>,
  keepCount: number,
): string[] {
  const normalizedKeepCount = normalizeKeepCount(keepCount);
  const removablePaths: string[] = [];

  for (const timestampEntries of groupedPaths.values()) {
    const staleTimestamps = Array.from(timestampEntries.keys())
      .sort((left, right) => right.localeCompare(left))
      .slice(normalizedKeepCount);

    for (const timestamp of staleTimestamps) {
      removablePaths.push(...(timestampEntries.get(timestamp) ?? []));
    }
  }

  return removablePaths;
}

function parseTimestampedFileName(name: string): TimestampedEntry | null {
  const parsedName = path.parse(name).name;
  const match = parsedName.match(SEGMENTED_TIMESTAMP_RE);
  if (!match?.[1] || !match[2]) {
    return null;
  }

  return {
    segment: match[1],
    timestamp: match[2],
  };
}

function parseTimestampedDirectoryName(name: string): TimestampedEntry | null {
  if (PURE_TIMESTAMP_RE.test(name)) {
    return {
      segment: DEFAULT_SEGMENT,
      timestamp: name,
    };
  }

  const match = name.match(SEGMENTED_TIMESTAMP_RE);
  if (!match?.[1] || !match[2]) {
    return null;
  }

  return {
    segment: match[1],
    timestamp: match[2],
  };
}

async function readDirectoryEntries(dirPath: string): Promise<fs.Dirent[] | null> {
  try {
    return await fs.promises.readdir(dirPath, { withFileTypes: true });
  } catch {
    return null;
  }
}

function normalizeKeepCount(keepCount: number): number {
  if (!Number.isFinite(keepCount) || keepCount < 1) {
    return DEFAULT_RETENTION_KEEP_COUNT;
  }

  return Math.floor(keepCount);
}