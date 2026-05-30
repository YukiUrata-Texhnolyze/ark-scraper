import fs from 'fs';
import path from 'path';
import { MarketOutputFormat, MarketResearchTarget } from '../types';
import { CsvManager } from './csv';
import { DEFAULT_RETENTION_KEEP_COUNT, pruneTimestampedFilesBySegment } from './retention';

export interface MarketOutputPaths {
  outputDir: string;
  baseName: string;
  csvPath: string;
  jsonlPath: string;
}

export type MarketOutputRecord = Record<string, unknown>;

export function formatMarketTimestamp(date: Date): string {
  const year = date.getFullYear();
  const month = pad2(date.getMonth() + 1);
  const day = pad2(date.getDate());
  const hour = pad2(date.getHours());
  const minute = pad2(date.getMinutes());
  const second = pad2(date.getSeconds());
  return `${year}-${month}-${day}_${hour}-${minute}-${second}`;
}

export function buildMarketOutputBaseName(target: MarketResearchTarget, date: Date): string {
  return `${target}_${formatMarketTimestamp(date)}`;
}

export async function createMarketOutputPaths(
  target: MarketResearchTarget,
  date: Date,
  outputDir?: string,
): Promise<MarketOutputPaths> {
  const resolvedOutputDir = path.resolve(process.env.OUTPUT_DIR ?? outputDir ?? './output');
  await fs.promises.mkdir(resolvedOutputDir, { recursive: true });

  const baseName = buildMarketOutputBaseName(target, date);
  return {
    outputDir: resolvedOutputDir,
    baseName,
    csvPath: path.join(resolvedOutputDir, `${baseName}.csv`),
    jsonlPath: path.join(resolvedOutputDir, `${baseName}.jsonl`),
  };
}

export async function writeMarketOutputs(
  outputPaths: MarketOutputPaths,
  formats: MarketOutputFormat[],
  records: MarketOutputRecord[],
): Promise<void> {
  const normalizedFormats = normalizeMarketOutputFormats(formats);

  if (normalizedFormats.includes('csv')) {
    await writeMarketCsv(outputPaths.csvPath, records);
  }

  if (normalizedFormats.includes('jsonl')) {
    await writeMarketJsonl(outputPaths.jsonlPath, records);
  }
}

export function getMarketOutputFiles(outputPaths: MarketOutputPaths, formats: MarketOutputFormat[]): string[] {
  const normalizedFormats = normalizeMarketOutputFormats(formats);
  return normalizedFormats.map((format) => (format === 'csv' ? outputPaths.csvPath : outputPaths.jsonlPath));
}

export function normalizeMarketOutputFormats(formats?: MarketOutputFormat[]): MarketOutputFormat[] {
  if (!formats || formats.length === 0) {
    return ['csv', 'jsonl'];
  }

  return Array.from(new Set(formats.filter((format) => format === 'csv' || format === 'jsonl')));
}

async function writeMarketCsv(filePath: string, records: MarketOutputRecord[]): Promise<void> {
  const parsedPath = path.parse(filePath);
  const headers = collectHeaders(records);

  await fs.promises.rm(filePath, { force: true }).catch(() => undefined);

  const csv = new CsvManager(parsedPath.base, parsedPath.dir);
  if (headers.length > 0) {
    headers.forEach((header, columnIndex) => {
      csv.writeCell(1, columnIndex + 1, header);
    });

    records.forEach((record, rowIndex) => {
      headers.forEach((header, columnIndex) => {
        csv.writeCell(rowIndex + 2, columnIndex + 1, serializeMarketValue(record[header]));
      });
    });
  }

  await csv.save();
}

async function writeMarketJsonl(filePath: string, records: MarketOutputRecord[]): Promise<void> {
  const payload = records
    .map((record) => JSON.stringify(record))
    .join('\n');

  await fs.promises.writeFile(filePath, `${payload}${records.length > 0 ? '\n' : ''}`, 'utf8');
  console.log(`[JSONL] 保存完了: ${filePath}`);
  await pruneTimestampedFilesBySegment(path.dirname(filePath), DEFAULT_RETENTION_KEEP_COUNT);
}

function collectHeaders(records: MarketOutputRecord[]): string[] {
  const headers = new Set<string>();
  for (const record of records) {
    Object.keys(record).forEach((key) => headers.add(key));
  }

  return Array.from(headers);
}

function serializeMarketValue(value: unknown): string | number {
  if (value === null || value === undefined) {
    return '';
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }

  return JSON.stringify(value);
}

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}