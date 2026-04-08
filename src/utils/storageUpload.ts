import fs from 'fs';
import path from 'path';
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';

export interface R2UploadFile {
  filePath: string;
  key: string;
  contentType?: string;
}

interface R2Config {
  endpoint?: string;
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  region: string;
  bucket: string;
}

export async function uploadFilesToR2IfConfigured(files: R2UploadFile[]): Promise<boolean> {
  const config = getR2Config();
  if (!config) {
    if (files.length > 0) {
      console.warn('[R2] アップロード設定が未構成のためスキップします');
    }
    return false;
  }

  const existingFiles = files
    .map((file) => ({
      ...file,
      filePath: path.resolve(file.filePath),
    }))
    .filter((file, index, array) => array.findIndex((candidate) => candidate.filePath === file.filePath && candidate.key === file.key) === index)
    .filter((file) => fs.existsSync(file.filePath));

  if (existingFiles.length === 0) {
    console.warn('[R2] アップロード対象ファイルがありません');
    return true;
  }

  console.log(`[R2] アップロード開始: ${existingFiles.length}件`);
  const client = createR2Client(config);

  for (const file of existingFiles) {
    await uploadSingleFileWithRetry(client, config.bucket, file);
  }

  console.log('[R2] アップロード完了');
  return true;
}

export function isR2UploadConfigured(): boolean {
  return getR2Config() !== null;
}

function getR2Config(): R2Config | null {
  const endpoint = pickEnv('AWS_ENDPOINT', 'R2_ENDPOINT');
  const accessKeyId = pickEnv('AWS_ACCESS_KEY_ID', 'R2_ACCESS_KEY_ID');
  const secretAccessKey = pickEnv('AWS_SECRET_ACCESS_KEY', 'R2_SECRET_ACCESS_KEY');
  const sessionToken = pickEnv('AWS_SESSION_TOKEN', 'R2_SESSION_TOKEN');
  const region = pickEnv('AWS_DEFAULT_REGION', 'R2_REGION') || 'auto';
  const bucket = pickEnv('AWS_BUCKET', 'R2_BUCKET');

  if (!accessKeyId || !secretAccessKey || !bucket) {
    return null;
  }

  return {
    endpoint: endpoint || undefined,
    accessKeyId,
    secretAccessKey,
    sessionToken: sessionToken || undefined,
    region,
    bucket,
  };
}

function pickEnv(...keys: string[]): string {
  for (const key of keys) {
    const value = process.env[key];
    if (value !== undefined && value !== '') {
      return value;
    }
  }

  return '';
}

function createR2Client(config: R2Config): S3Client {
  return new S3Client({
    region: config.region,
    ...(config.endpoint ? { endpoint: config.endpoint } : {}),
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
      ...(config.sessionToken ? { sessionToken: config.sessionToken } : {}),
    },
  });
}

async function uploadSingleFileWithRetry(
  client: S3Client,
  bucket: string,
  file: R2UploadFile,
): Promise<void> {
  const maxAttempts = 3;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const body = await fs.promises.readFile(file.filePath);
      await client.send(new PutObjectCommand({
        Bucket: bucket,
        Key: file.key,
        Body: body,
        ContentType: file.contentType || resolveContentType(file.filePath),
      }));

      console.log(`[R2] アップロード成功: s3://${bucket}/${file.key}`);
      return;
    } catch (error) {
      if (attempt >= maxAttempts) {
        throw new Error(
          `[R2] ファイルアップロード失敗 (${path.basename(file.filePath)}): ${error instanceof Error ? error.message : String(error)}`,
        );
      }

      const delayMs = 500 * (2 ** (attempt - 1));
      console.warn(`[R2] 再試行 ${attempt}/${maxAttempts - 1}: ${path.basename(file.filePath)} (${delayMs}ms後)`);
      await sleep(delayMs);
    }
  }
}

function resolveContentType(filePath: string): string {
  const extension = path.extname(filePath).toLowerCase();
  if (extension === '.csv') {
    return 'text/csv; charset=utf-8';
  }

  if (extension === '.json') {
    return 'application/json; charset=utf-8';
  }

  return 'application/octet-stream';
}

async function sleep(delayMs: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, delayMs));
}