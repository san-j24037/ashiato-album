const POINT_HEADERS = ['userSub', 'id', 'latitude', 'longitude', 'accuracy', 'recordedAt'];
const MEMORY_HEADERS = ['userSub', 'id', 'title', 'note', 'latitude', 'longitude', 'createdAt', 'driveFiles'];
const USER_HEADERS = [
  'userId',
  'email',
  'displayName',
  'passwordSalt',
  'passwordHash',
  'createdAt',
  'lastLoginAt',
  'failedAttempts',
  'lockedUntil'
];
const MAX_LOGIN_FAILURES = 5;
const LOGIN_LOCK_MS = 15 * 60 * 1000;

function doPost(event) {
  let lock;
  try {
    const body = JSON.parse(event.postData.contents || '{}');
    verifyServiceKey(body.serviceKey);
    lock = LockService.getScriptLock();
    if (!lock.tryLock(10000)) {
      throw new Error('Database is busy. Please retry shortly');
    }
    const spreadsheet = getDatabase();
    const usersSheet = getOrCreateSheet(spreadsheet, 'Users', USER_HEADERS);

    if (body.action === 'accountRegister') {
      return jsonResponse(registerAccount(usersSheet, body));
    }
    if (body.action === 'accountLookup') {
      return jsonResponse(lookupAccount(usersSheet, body.email));
    }
    if (body.action === 'accountLoginFailure') {
      return jsonResponse(recordLoginFailure(usersSheet, body.email));
    }
    if (body.action === 'accountLoginSuccess') {
      return jsonResponse(recordLoginSuccess(usersSheet, body.email));
    }

    const user = verifySessionToken(body.sessionToken);
    const pointsSheet = getOrCreateSheet(spreadsheet, 'Points', POINT_HEADERS);
    const memoriesSheet = getOrCreateSheet(spreadsheet, 'Spots', MEMORY_HEADERS);

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

function verifyServiceKey(serviceKey) {
  const expected = PropertiesService.getScriptProperties().getProperty('GAS_SERVICE_KEY');
  if (!expected || !constantTimeEquals(String(serviceKey || ''), expected)) {
    throw new Error('Request is not authorized');
  }
}

function verifySessionToken(token) {
  const secret = PropertiesService.getScriptProperties().getProperty('APP_SESSION_SECRET');
  if (!secret || typeof token !== 'string' || token.length > 4096) {
    throw new Error('A valid account session is required');
  }
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('Account session is invalid');
  let header;
  try {
    header = JSON.parse(
      Utilities.newBlob(Utilities.base64DecodeWebSafe(parts[0])).getDataAsString()
    );
  } catch (error) {
    throw new Error('Account session is invalid');
  }
  if (!header || header.alg !== 'HS256' || header.typ !== 'JWT') {
    throw new Error('Account session is invalid');
  }
  const content = parts[0] + '.' + parts[1];
  const expectedSignature = Utilities.base64EncodeWebSafe(
    Utilities.computeHmacSha256Signature(content, secret)
  ).replace(/=+$/g, '');
  if (!constantTimeEquals(parts[2], expectedSignature)) {
    throw new Error('Account session is invalid');
  }

  let claims;
  try {
    claims = JSON.parse(
      Utilities.newBlob(Utilities.base64DecodeWebSafe(parts[1])).getDataAsString()
    );
  } catch (error) {
    throw new Error('Account session is invalid');
  }
  const now = Date.now() / 1000;
  if (
    !claims ||
    typeof claims.sub !== 'string' ||
    !/^[a-f0-9-]{36}$/i.test(claims.sub) ||
    typeof claims.email !== 'string' ||
    typeof claims.name !== 'string' ||
    !Number.isFinite(claims.exp) ||
    claims.exp <= now ||
    !Number.isFinite(claims.iat) ||
    claims.iat > now + 60
  ) {
    throw new Error('Account session is invalid or expired');
  }
  return { sub: claims.sub, email: claims.email, name: claims.name };
}

function constantTimeEquals(actual, expected) {
  if (typeof actual !== 'string' || typeof expected !== 'string' || actual.length !== expected.length) {
    return false;
  }
  let difference = 0;
  for (let index = 0; index < actual.length; index += 1) {
    difference |= actual.charCodeAt(index) ^ expected.charCodeAt(index);
  }
  return difference === 0;
}

function registerAccount(sheet, body) {
  const account = body.account;
  if (
    !account ||
    typeof account.id !== 'string' ||
    !/^[a-f0-9-]{36}$/i.test(account.id) ||
    typeof account.name !== 'string' ||
    account.name.length < 1 ||
    account.name.length > 80 ||
    /[\u0000-\u001f\u007f]/.test(account.name) ||
    !isValidEmail(account.email) ||
    !/^[A-Za-z0-9_-]{22}$/.test(body.passwordSalt || '') ||
    !/^[A-Za-z0-9_-]{43}$/.test(body.passwordHash || '')
  ) {
    throw new Error('Registration data is invalid');
  }

  const email = account.email.trim().toLowerCase();
  const rows = readSheet(sheet);
  if (rows.slice(1).some(row => String(row[1]).trim().toLowerCase() === email)) {
    return { ok: false, code: 'EMAIL_EXISTS' };
  }
  appendRows(sheet, [[
    account.id,
    email,
    account.name.trim(),
    body.passwordSalt,
    body.passwordHash,
    new Date(),
    '',
    0,
    0
  ]]);
  return { ok: true };
}

function lookupAccount(sheet, emailValue) {
  if (!isValidEmail(emailValue)) throw new Error('Email is invalid');
  const email = emailValue.trim().toLowerCase();
  const rows = readSheet(sheet);
  const row = rows.slice(1).find(item => String(item[1]).trim().toLowerCase() === email);
  if (!row) return { ok: true, user: null };
  return {
    ok: true,
    user: {
      userId: String(row[0]),
      email: String(row[1]),
      displayName: String(row[2]),
      passwordSalt: String(row[3]),
      passwordHash: String(row[4]),
      failedAttempts: Number(row[7]) || 0,
      lockedUntil: toTimestamp(row[8])
    }
  };
}

function recordLoginFailure(sheet, emailValue) {
  const user = findUserRow(sheet, emailValue);
  if (!user) return { ok: true };
  const now = Date.now();
  let failures = Number(user.values[7]) || 0;
  let lockedUntil = toTimestamp(user.values[8]);
  if (lockedUntil <= now) {
    if (failures >= MAX_LOGIN_FAILURES) failures = 0;
    lockedUntil = 0;
  }
  failures += 1;
  if (failures >= MAX_LOGIN_FAILURES) lockedUntil = now + LOGIN_LOCK_MS;
  sheet.getRange(user.row, 8, 1, 2).setValues([[failures, lockedUntil]]);
  return { ok: true };
}

function recordLoginSuccess(sheet, emailValue) {
  const user = findUserRow(sheet, emailValue);
  if (!user || toTimestamp(user.values[8]) > Date.now()) {
    throw new Error('Account is unavailable');
  }
  sheet.getRange(user.row, 7, 1, 3).setValues([[new Date(), 0, 0]]);
  return { ok: true };
}

function findUserRow(sheet, emailValue) {
  if (!isValidEmail(emailValue)) return null;
  const email = emailValue.trim().toLowerCase();
  const rows = readSheet(sheet);
  const index = rows.slice(1).findIndex(row => String(row[1]).trim().toLowerCase() === email);
  return index < 0 ? null : { row: index + 2, values: rows[index + 1] };
}

function isValidEmail(value) {
  return typeof value === 'string' &&
    value.length <= 254 &&
    /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());
}

function toTimestamp(value) {
  if (value instanceof Date) return value.getTime();
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : 0;
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
