const { URL, URLSearchParams } = require('url');

async function fetchJson(url, options) {
  const response = await fetch(url, options);
  if (!response.ok) {
    throw new Error(`${response.status} ${await response.text()}`);
  }

  return response.json();
}

function normalizeSharePointFolderPath(folderPath) {
  const normalized = folderPath
    .split('/')
    .filter(Boolean)
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

function extractDriveLibrarySegments(driveWebUrl) {
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

function startsWithSegments(value, prefix) {
  if (prefix.length > value.length) {
    return false;
  }

  return prefix.every((segment, index) => value[index] === segment);
}

function resolveDriveRelativeFolderPath(folderPath, drive) {
  const segments = folderPath.split('/').filter((segment) => segment.length > 0);
  const driveLibrarySegments = extractDriveLibrarySegments(drive.webUrl);
  let relativeSegments = [...segments];

  if (driveLibrarySegments.length > 0 && startsWithSegments(relativeSegments, driveLibrarySegments)) {
    relativeSegments = relativeSegments.slice(driveLibrarySegments.length);
  } else if (relativeSegments[0] === 'Shared Documents' || relativeSegments[0] === drive.name) {
    relativeSegments = relativeSegments.slice(1);
  }

  return relativeSegments.join('/');
}

function encodeSharePointPath(value) {
  return value
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/');
}

async function listAllChildren(accessToken, siteId, relativeFolderPath) {
  let nextUrl = `https://graph.microsoft.com/v1.0/sites/${siteId}/drive/root:/${encodeSharePointPath(relativeFolderPath)}:/children?$select=id,name,lastModifiedDateTime,file,folder&$top=999`;
  const items = [];

  while (nextUrl) {
    const json = await fetchJson(nextUrl, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    items.push(...(json.value ?? []));
    nextUrl = json['@odata.nextLink'] ?? null;
  }

  return items;
}

async function deleteItem(accessToken, siteId, itemId) {
  const response = await fetch(`https://graph.microsoft.com/v1.0/sites/${siteId}/drive/items/${itemId}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (!response.ok) {
    throw new Error(`${response.status} ${await response.text()}`);
  }
}

async function main() {
  const tenantId = process.env.SHAREPOINT_TENANT_ID;
  const clientId = process.env.SHAREPOINT_CLIENT_ID;
  const clientSecret = process.env.SHAREPOINT_CLIENT_SECRET;
  const siteUrl = process.env.SHAREPOINT_SITE_URL;
  const folderPath = process.env.SHAREPOINT_FOLDER_PATH;

  if (!tenantId || !clientId || !clientSecret || !siteUrl || !folderPath) {
    throw new Error('SharePoint configuration is incomplete.');
  }

  const token = await fetchJson(`https://login.microsoftonline.com/${encodeURIComponent(tenantId)}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      scope: 'https://graph.microsoft.com/.default',
      grant_type: 'client_credentials',
    }).toString(),
  });

  const site = await fetchJson(`https://graph.microsoft.com/v1.0/sites/${new URL(siteUrl).hostname}:${new URL(siteUrl).pathname.replace(/\/$/, '')}?$select=id,webUrl`, {
    headers: { Authorization: `Bearer ${token.access_token}` },
  });

  const drive = await fetchJson(`https://graph.microsoft.com/v1.0/sites/${site.id}/drive?$select=id,name,webUrl`, {
    headers: { Authorization: `Bearer ${token.access_token}` },
  });

  const relativeFolderPath = resolveDriveRelativeFolderPath(normalizeSharePointFolderPath(folderPath), drive);
  const cutoff = new Date();
  cutoff.setMonth(cutoff.getMonth() - 1);

  const before = await listAllChildren(token.access_token, site.id, relativeFolderPath);
  const expired = before.filter((item) => item.id && item.file && item.lastModifiedDateTime && new Date(item.lastModifiedDateTime) < cutoff);
  const queue = [...expired];
  const failures = [];
  let deleted = 0;

  async function worker() {
    while (queue.length > 0) {
      const item = queue.shift();
      if (!item) {
        return;
      }

      try {
        await deleteItem(token.access_token, site.id, item.id);
        deleted += 1;
      } catch (error) {
        failures.push({
          name: item.name,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(8, queue.length || 1) }, () => worker()));

  const after = await listAllChildren(token.access_token, site.id, relativeFolderPath);
  const remainingExpired = after.filter((item) => item.id && item.file && item.lastModifiedDateTime && new Date(item.lastModifiedDateTime) < cutoff);

  console.log(JSON.stringify({
    relativeFolderPath,
    expiredBefore: expired.length,
    deleted,
    failures: failures.length,
    remainingExpired: remainingExpired.length,
  }, null, 2));

  if (failures.length > 0) {
    console.log(JSON.stringify(failures.slice(0, 10), null, 2));
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});