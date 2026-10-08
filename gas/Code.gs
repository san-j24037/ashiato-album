const POINT_HEADERS = ['userSub', 'id', 'latitude', 'longitude', 'accuracy', 'recordedAt'];
const MEMORY_HEADERS = ['userSub', 'id', 'title', 'note', 'latitude', 'longitude', 'createdAt', 'driveFiles'];

function doPost(event) {
  let lock;
  try {
    const body = JSON.parse(event.postData.contents || '{}');
    const user = verifyIdentityToken(body.idToken);
    lock = LockService.getScriptLock();
    if (!lock.tryLock(10000)) {
      throw new Error('Database is busy. Please retry shortly');
    }
    const spreadsheet = getDatabase();
    const pointsSheet = getOrCreateSheet(spreadsheet, 'Points', POINT_HEADERS);
    const memoriesSheet = getOrCreateSheet(spreadsheet, 'Spots', MEMORY_HEADERS);

    if (body.action === 'load') {
      return jsonResponse({ ok: true, data: readUserData(user.sub, pointsSheet, memoriesSheet) });
    }
    if (body.action !== 'sync') {
      throw new Error('Unsupported action');
    }

    const incoming = body.data || {};
    if (!Array.isArray(incoming.points) || !Array.isArray(incoming.memories)) {
      throw new Error('Sync data must include location and spot arrays');
    }
    const points = incoming.points;
    const memories = incoming.memories;
    if (points.length > 5000 || memories.length > 1000) {
      throw new Error('This sync batch exceeds the allowed record count');
    }
    if (!points.every(isValidPoint) || !memories.every(isValidMemory)) {
      throw new Error('Sync contains an invalid location or spot');
    }

    mergePoints(user.sub, pointsSheet, points);
    mergeMemories(user.sub, memoriesSheet, memories);
    return jsonResponse({ ok: true, data: readUserData(user.sub, pointsSheet, memoriesSheet) });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unexpected server error';
    return jsonResponse({ ok: false, error: message });
  } finally {
    if (lock && lock.hasLock()) lock.releaseLock();
  }
}

function verifyIdentityToken(idToken) {
  if (typeof idToken !== 'string' || idToken.length < 20 || idToken.length > 5000) {
    throw new Error('A valid Google sign-in is required');
  }
  const expectedClientId = PropertiesService.getScriptProperties().getProperty('GOOGLE_CLIENT_ID');
  if (!expectedClientId) {
    throw new Error('Set the GOOGLE_CLIENT_ID script property before using sync');
  }

  const response = UrlFetchApp.fetch(
    'https://oauth2.googleapis.com/tokeninfo?id_token=' + encodeURIComponent(idToken),
    { muteHttpExceptions: true }
  );
  if (response.getResponseCode() !== 200) {
    throw new Error('Google sign-in could not be verified');
  }

  const claims = JSON.parse(response.getContentText());
  if (claims.aud !== expectedClientId || !claims.sub || Number(claims.exp) <= Date.now() / 1000) {
    throw new Error('Google sign-in token is invalid or expired');
  }
  if (claims.email_verified !== 'true') {
    throw new Error('A verified Google account is required');
  }
  return { sub: String(claims.sub) };
}

function getDatabase() {
  const spreadsheetId = PropertiesService.getScriptProperties().getProperty('SPREADSHEET_ID');
  if (!spreadsheetId) {
    throw new Error('Set the SPREADSHEET_ID script property before using sync');
  }
  return SpreadsheetApp.openById(spreadsheetId);
}

function getOrCreateSheet(spreadsheet, name, headers) {
  let sheet = spreadsheet.getSheetByName(name);
  if (!sheet) {
    sheet = spreadsheet.insertSheet(name);
    sheet.appendRow(headers);
  } else if (sheet.getLastRow() === 0) {
    sheet.appendRow(headers);
  }
  return sheet;
}

function mergePoints(userSub, sheet, points) {
  const existing = readSheet(sheet);
  const known = new Set(
    existing.slice(1).filter(row => String(row[0]) === userSub).map(row => String(row[1]))
  );
  const rows = [];
  points.forEach(point => {
    if (known.has(point.id)) return;
    known.add(point.id);
    rows.push([userSub, point.id, point.latitude, point.longitude, point.accuracy, point.recordedAt]);
  });
  appendRows(sheet, rows);
}

function mergeMemories(userSub, sheet, memories) {
  const rows = readSheet(sheet);
  const rowById = new Map();
  rows.slice(1).forEach((row, index) => {
    if (String(row[0]) === userSub) rowById.set(String(row[1]), index + 2);
  });

  memories.forEach(memory => {
    const row = [
      userSub,
      memory.id,
      memory.title,
      memory.note,
      memory.latitude,
      memory.longitude,
      memory.createdAt,
      JSON.stringify(Array.isArray(memory.driveFiles) ? memory.driveFiles : [])
    ];
    const existingRow = rowById.get(memory.id);
    if (existingRow) {
      sheet.getRange(existingRow, 1, 1, row.length).setValues([row]);
    } else {
      rowById.set(memory.id, sheet.getLastRow() + 1);
      appendRows(sheet, [row]);
    }
  });
}

function readUserData(userSub, pointsSheet, memoriesSheet) {
  const points = readSheet(pointsSheet).slice(1)
    .filter(row => String(row[0]) === userSub)
    .map(row => ({
      id: String(row[1]),
      latitude: Number(row[2]),
      longitude: Number(row[3]),
      accuracy: Number(row[4]),
      recordedAt: toIsoString(row[5])
    }));
  const memories = readSheet(memoriesSheet).slice(1)
    .filter(row => String(row[0]) === userSub)
    .map(row => ({
      id: String(row[1]),
      title: String(row[2]),
      note: String(row[3]),
      latitude: Number(row[4]),
      longitude: Number(row[5]),
      createdAt: toIsoString(row[6]),
      driveFiles: parseDriveFiles(row[7])
    }));
  return { points: points, memories: memories };
}

function toIsoString(value) {
  return value instanceof Date ? value.toISOString() : String(value);
}

function parseDriveFiles(value) {
  try {
    const files = JSON.parse(String(value || '[]'));
    return Array.isArray(files) ? files : [];
  } catch (error) {
    console.error('Could not parse Drive attachment metadata', error);
    return [];
  }
}

function readSheet(sheet) {
  const lastRow = sheet.getLastRow();
  if (lastRow === 0) return [];
  return sheet.getRange(1, 1, lastRow, sheet.getLastColumn()).getValues();
}

function appendRows(sheet, rows) {
  if (!rows.length) return;
  sheet.getRange(sheet.getLastRow() + 1, 1, rows.length, rows[0].length).setValues(rows);
}

function isValidPoint(point) {
  return point && typeof point.id === 'string' && point.id.length <= 120 &&
    Number.isFinite(point.latitude) && point.latitude >= -90 && point.latitude <= 90 &&
    Number.isFinite(point.longitude) && point.longitude >= -180 && point.longitude <= 180 &&
    Number.isFinite(point.accuracy) && point.accuracy >= 0 &&
    typeof point.recordedAt === 'string' && !isNaN(Date.parse(point.recordedAt));
}

function isValidMemory(memory) {
  return memory && typeof memory.id === 'string' && memory.id.length <= 120 &&
    typeof memory.title === 'string' && memory.title.length > 0 && memory.title.length <= 200 &&
    typeof memory.note === 'string' && memory.note.length <= 2000 &&
    Number.isFinite(memory.latitude) && memory.latitude >= -90 && memory.latitude <= 90 &&
    Number.isFinite(memory.longitude) && memory.longitude >= -180 && memory.longitude <= 180 &&
    typeof memory.createdAt === 'string' && !isNaN(Date.parse(memory.createdAt)) &&
    Array.isArray(memory.driveFiles) && memory.driveFiles.length <= 100 &&
    memory.driveFiles.every(isValidDriveFile);
}

function isValidDriveFile(file) {
  return file && typeof file.id === 'string' && file.id.length <= 200 &&
    typeof file.name === 'string' && file.name.length <= 500 &&
    typeof file.mimeType === 'string' && file.mimeType.length <= 200 &&
    typeof file.url === 'string' &&
    /^https:\/\/drive\.google\.com\/file\/d\/[A-Za-z0-9_-]+\/view$/.test(file.url);
}

function jsonResponse(value) {
  return ContentService.createTextOutput(JSON.stringify(value))
    .setMimeType(ContentService.MimeType.JSON);
}
