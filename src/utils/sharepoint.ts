import fs from 'fs';
import path from 'path';

interface SharePointConfig {
  tenantId: string;
  clientId: string;
  clientSecret: string;
  siteUrl: string;
  folderPath: string;
}

interface SharePointDriveItem {
  id?: string;
  name?: string;
  webUrl?: string;
  lastModifiedDateTime?: string;
  file?: { mimeType?: string };
  folder?: { childCount?: number };
}

interface SharePointDriveInfo {
  id: string;
  name: string;
  webUrl: string;
}

interface GraphCollectionResponse<T> {
  value?: T[];
  '@odata.nextLink'?: string;
}

export async function uploadFilesToSharePointIfConfigured(filePaths: string[]): Promise<void> {
  const config = getSharePointConfig();
  if (!config) {
    return;
  }

  const existingFiles = filePaths
    .map((filePath) => path.resolve(filePath))
    .filter((filePath, index, array) => array.indexOf(filePath) === index)
    .filter((filePath) => fs.existsSync(filePath));

  if (existingFiles.length === 0) {
    console.warn('[SharePoint] アップロード対象ファイルがありません');
    return;
  }

  console.log(`[SharePoint] アップロード開始: ${existingFiles.length}件`);

  const accessToken = await getMicrosoftGraphAccessToken(config);
  const siteId = await getSharePointSiteId(config, accessToken);
  const drive = await getSharePointDriveInfo(siteId, accessToken);
  const driveRelativeFolderPath = resolveDriveRelativeFolderPath(config.folderPath, drive);

  console.log(`[SharePoint] 保存先フォルダ: ${drive.webUrl}/${encodeSharePointPath(driveRelativeFolderPath)}`);

  await deleteOldFilesInSharePointFolder(accessToken, siteId, driveRelativeFolderPath);

  for (const filePath of existingFiles) {
    await uploadSingleFile(accessToken, siteId, driveRelativeFolderPath, filePath);
  }

  console.log('[SharePoint] アップロード完了');
}

export function isSharePointUploadConfigured(): boolean {
  return getSharePointConfig() !== null;
}

function getSharePointConfig(): SharePointConfig | null {
  const tenantId = process.env.SHAREPOINT_TENANT_ID ?? '';
  const clientId = process.env.SHAREPOINT_CLIENT_ID ?? '';
  const clientSecret = process.env.SHAREPOINT_CLIENT_SECRET ?? '';
  const siteUrl = process.env.SHAREPOINT_SITE_URL ?? '';
  const folderPath = process.env.SHAREPOINT_FOLDER_PATH ?? '';

  if (!tenantId || !clientId || !clientSecret || !siteUrl || !folderPath) {
    return null;
  }

  return {
    tenantId,
    clientId,
    clientSecret,
    siteUrl,
    folderPath: normalizeSharePointFolderPath(folderPath),
  };
}

async function getMicrosoftGraphAccessToken(config: SharePointConfig): Promise<string> {
  const tokenUrl = `https://login.microsoftonline.com/${encodeURIComponent(config.tenantId)}/oauth2/v2.0/token`;
  const body = new URLSearchParams({
    client_id: config.clientId,
    client_secret: config.clientSecret,
    scope: 'https://graph.microsoft.com/.default',
    grant_type: 'client_credentials',
  });

  const response = await fetch(tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });

  if (!response.ok) {
    throw new Error(`[SharePoint] トークン取得失敗: ${response.status} ${await response.text()}`);
  }

  const json = await response.json() as { access_token?: string };
  if (!json.access_token) {
    throw new Error('[SharePoint] access_token が取得できませんでした');
  }

  return json.access_token;
}

async function getSharePointSiteId(config: SharePointConfig, accessToken: string): Promise<string> {
  const { hostname, pathname } = new URL(config.siteUrl);
  const normalizedPath = pathname.replace(/\/$/, '');
  const endpoint = `https://graph.microsoft.com/v1.0/sites/${hostname}:${normalizedPath}?$select=id,webUrl`;
  const response = await fetch(endpoint, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (!response.ok) {
    throw new Error(`[SharePoint] site id 取得失敗: ${response.status} ${await response.text()}`);
  }

  const json = await response.json() as { id?: string };
  if (!json.id) {
    throw new Error('[SharePoint] site id が取得できませんでした');
  }

  return json.id;
}

async function uploadSingleFile(
  accessToken: string,
  siteId: string,
  driveRelativeFolderPath: string,
  filePath: string,
): Promise<void> {
  const fileName = path.basename(filePath);
  const remotePath = buildSharePointRemotePath(driveRelativeFolderPath, fileName);
  const uploadUrl = `https://graph.microsoft.com/v1.0/sites/${siteId}/drive/root:/${encodeSharePointPath(remotePath)}:/content`;
  const buffer = await fs.promises.readFile(filePath);

  const response = await fetch(uploadUrl, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'text/csv',
    },
    body: buffer,
  });

  if (!response.ok) {
    throw new Error(`[SharePoint] ファイルアップロード失敗 (${fileName}): ${response.status} ${await response.text()}`);
  }

  console.log(`[SharePoint] アップロード成功: ${remotePath}`);
}

async function deleteOldFilesInSharePointFolder(
  accessToken: string,
  siteId: string,
  driveRelativeFolderPath: string,
): Promise<void> {
  const items = await listSharePointFolderChildren(accessToken, siteId, driveRelativeFolderPath);
  const cutoff = new Date();
  cutoff.setMonth(cutoff.getMonth() - 1);

  const expiredFiles = items.filter((item) => {
    if (!item.id || !item.file || !item.lastModifiedDateTime) {
      return false;
    }

    const lastModified = new Date(item.lastModifiedDateTime);
    return Number.isFinite(lastModified.getTime()) && lastModified < cutoff;
  });

  if (expiredFiles.length === 0) {
    return;
  }

  console.log(`[SharePoint] 1か月超過ファイル削除開始: ${expiredFiles.length}件`);

  for (const item of expiredFiles) {
    const deleteUrl = `https://graph.microsoft.com/v1.0/sites/${siteId}/drive/items/${item.id}`;
    const deleteResponse = await fetch(deleteUrl, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    if (!deleteResponse.ok) {
      throw new Error(`[SharePoint] 古いファイル削除失敗 (${item.name ?? item.id}): ${deleteResponse.status} ${await deleteResponse.text()}`);
    }

    console.log(`[SharePoint] 古いファイル削除: ${item.name ?? item.id}`);
  }
}

async function listSharePointFolderChildren(
  accessToken: string,
  siteId: string,
  driveRelativeFolderPath: string,
): Promise<SharePointDriveItem[]> {
  const items: SharePointDriveItem[] = [];
  let nextUrl = `https://graph.microsoft.com/v1.0/sites/${siteId}/drive/root:/${encodeSharePointPath(driveRelativeFolderPath)}:/children?$select=id,name,webUrl,lastModifiedDateTime,file,folder&$top=999`;

  while (nextUrl) {
    const response = await fetch(nextUrl, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    if (!response.ok) {
      throw new Error(`[SharePoint] 既存ファイル一覧取得失敗: ${response.status} ${await response.text()}`);
    }

    const json = await response.json() as GraphCollectionResponse<SharePointDriveItem>;
    items.push(...(json.value ?? []));
    nextUrl = json['@odata.nextLink'] ?? '';
  }

  return items;
}

async function getSharePointDriveInfo(siteId: string, accessToken: string): Promise<SharePointDriveInfo> {
  const response = await fetch(`https://graph.microsoft.com/v1.0/sites/${siteId}/drive?$select=id,name,webUrl`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (!response.ok) {
    throw new Error(`[SharePoint] drive 情報取得失敗: ${response.status} ${await response.text()}`);
  }

  const json = await response.json() as Partial<SharePointDriveInfo>;
  if (!json.id || !json.name || !json.webUrl) {
    throw new Error('[SharePoint] drive 情報が不足しています');
  }

  return {
    id: json.id,
    name: json.name,
    webUrl: json.webUrl,
  };
}

function buildSharePointRemotePath(folderPath: string, fileName: string): string {
  const normalizedFolderPath = folderPath
    .split('/')
    .filter((segment) => segment.length > 0)
    .join('/');

  return `${normalizedFolderPath}/${fileName}`;
}

function normalizeSharePointFolderPath(folderPath: string): string {
  const normalized = folderPath
    .split('/')
    .filter((segment) => segment.length > 0)
    .map((segment) => {
      try {
        return decodeURIComponent(segment);
      } catch {
        return segment;
      }
    })
    .join('/');

  return `/${normalized}`;
}

function resolveDriveRelativeFolderPath(folderPath: string, drive: SharePointDriveInfo): string {
  const segments = folderPath
    .split('/')
    .filter((segment) => segment.length > 0);
  const driveLibrarySegments = extractDriveLibrarySegments(drive.webUrl);

  let relativeSegments = [...segments];
  if (driveLibrarySegments.length > 0 && startsWithSegments(relativeSegments, driveLibrarySegments)) {
    relativeSegments = relativeSegments.slice(driveLibrarySegments.length);
  } else if (relativeSegments[0] === 'Shared Documents' || relativeSegments[0] === drive.name) {
    relativeSegments = relativeSegments.slice(1);
  }

  if (relativeSegments.length === 0) {
    throw new Error('[SharePoint] 保存先フォルダの解決に失敗しました');
  }

  return relativeSegments.join('/');
}

function extractDriveLibrarySegments(driveWebUrl: string): string[] {
  try {
    const pathname = decodeURIComponent(new URL(driveWebUrl).pathname);
    const segments = pathname.split('/').filter((segment) => segment.length > 0);
    const sharedDocumentsIndex = segments.indexOf('Shared Documents');
    if (sharedDocumentsIndex >= 0) {
      return segments.slice(sharedDocumentsIndex);
    }
    return segments.slice(-1);
  } catch {
    return [];
  }
}

function startsWithSegments(value: string[], prefix: string[]): boolean {
  if (prefix.length > value.length) {
    return false;
  }

  return prefix.every((segment, index) => value[index] === segment);
}

function encodeSharePointPath(value: string): string {
  return value
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/');
}