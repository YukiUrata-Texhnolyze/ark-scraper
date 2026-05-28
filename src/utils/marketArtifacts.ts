import fs from 'fs';
import path from 'path';
import { Page } from 'playwright';
import { MarketArtifactErrorInfo, MarketArtifactMetadata, MarketResearchTarget } from '../types';
import { formatMarketTimestamp } from './marketOutput';

export interface MarketArtifactPaths {
  artifactDir: string;
  metadataPath: string;
  htmlPath: string;
  screenshotPath: string;
  errorMetadataPath: string;
  errorHtmlPath: string;
  errorScreenshotPath: string;
}

export function createMarketArtifactPaths(
  project: string,
  target: MarketResearchTarget,
  runAt: Date,
  artifactRootDir?: string,
  artifactLabel?: string,
): MarketArtifactPaths {
  const resolvedRootDir = path.resolve(process.env.MARKET_ARTIFACT_DIR ?? artifactRootDir ?? './playwright-artifacts/market-research');
  const runDir = path.join(resolvedRootDir, sanitizePathSegment(project), target, formatMarketTimestamp(runAt));
  const artifactDir = artifactLabel ? path.join(runDir, sanitizePathSegment(artifactLabel)) : runDir;

  return {
    artifactDir,
    metadataPath: path.join(artifactDir, 'metadata.json'),
    htmlPath: path.join(artifactDir, 'page.html'),
    screenshotPath: path.join(artifactDir, 'screenshot.png'),
    errorMetadataPath: path.join(artifactDir, 'error-metadata.json'),
    errorHtmlPath: path.join(artifactDir, 'error.html'),
    errorScreenshotPath: path.join(artifactDir, 'error.png'),
  };
}

export async function saveMarketSuccessArtifacts(
  page: Page,
  artifactPaths: MarketArtifactPaths,
  metadata: MarketArtifactMetadata,
): Promise<void> {
  await ensureDirectory(artifactPaths.artifactDir);
  await writeJsonFile(artifactPaths.metadataPath, metadata);
  await capturePageHtml(page, artifactPaths.htmlPath);
  await captureScreenshot(page, artifactPaths.screenshotPath);
}

export async function saveMarketErrorArtifacts(
  page: Page,
  artifactPaths: MarketArtifactPaths,
  metadata: MarketArtifactMetadata,
): Promise<void> {
  await ensureDirectory(artifactPaths.artifactDir);
  await writeJsonFile(artifactPaths.errorMetadataPath, metadata);
  await capturePageHtml(page, artifactPaths.errorHtmlPath);
  await captureScreenshot(page, artifactPaths.errorScreenshotPath);
}

export function toMarketArtifactErrorInfo(error: unknown): MarketArtifactErrorInfo {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack,
    };
  }

  return {
    message: String(error),
  };
}

async function capturePageHtml(page: Page, filePath: string): Promise<void> {
  try {
    const html = await page.content();
    await fs.promises.writeFile(filePath, html, 'utf8');
  } catch (error) {
    console.warn(`[Market] HTML保存失敗: ${filePath}`, error);
  }
}

async function captureScreenshot(page: Page, filePath: string): Promise<void> {
  try {
    await page.screenshot({ path: filePath, fullPage: true });
  } catch (error) {
    console.warn(`[Market] スクリーンショット保存失敗: ${filePath}`, error);
  }
}

async function writeJsonFile(filePath: string, payload: unknown): Promise<void> {
  await fs.promises.writeFile(filePath, JSON.stringify(payload, null, 2), 'utf8');
  console.log(`[Market] JSON 保存完了: ${filePath}`);
}

async function ensureDirectory(dirPath: string): Promise<void> {
  await fs.promises.mkdir(dirPath, { recursive: true });
}

function sanitizePathSegment(value: string): string {
  return value.replace(/[\\/]/g, '-').trim() || 'unknown-project';
}