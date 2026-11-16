const POINT_HEADERS = ['userSub', 'id', 'latitude', 'longitude', 'accuracy', 'recordedAt'];
const MEMORY_HEADERS = [
  'userSub',
  'id',
  'title',
  'note',
  'latitude',
  'longitude',
  'createdAt',
  'driveFiles',
  'address',
  'isPublic',
  'ownerName',
  'listId',
  'mark'
];
const LEGACY_SPOT_HEADERS = MEMORY_HEADERS.slice(0, 8);
const LIST_HEADERS = ['userSub', 'id', 'name', 'mark', 'createdAt', 'updatedAt', 'deletedAt'];
const USER_HEADERS = [
  'userId',
  'email',
  'displayName',
  'passwordSalt',
  'passwordHash',
  'createdAt',
  'lastLoginAt',
  'failedAttempts',
  'lockedUntil',
  'resetCodeHash',
  'resetExpiresAt',
  'resetAttempts',
  'resetRequestedAt'
];
const MAX_LOGIN_FAILURES = 5;
const LOGIN_LOCK_MS = 15 * 60 * 1000;
const RESET_CODE_TTL_MS = 15 * 60 * 1000;
const RESET_RESEND_INTERVAL_MS = 60 * 1000;
const MAX_RESET_ATTEMPTS = 5;
// Stop sending reset mail while this many messages of the daily MailApp quota still remain,
// so the free-tier limit (about 100/day) is never actually exceeded.
const MAIL_QUOTA_RESERVE = 5;
const ADMIN_DETAIL_POINT_LIMIT = 2000;

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
    if (body.action === 'passwordResetRequest') {
      return jsonResponse(requestPasswordReset(usersSheet, body.email));
    }
    if (body.action === 'passwordResetConfirm') {
      return jsonResponse(confirmPasswordReset(usersSheet, body));
    }

    const user = verifySessionToken(body.sessionToken);
    const pointsSheet = getOrCreateSheet(spreadsheet, 'Points', POINT_HEADERS);
    const memoriesSheet = getOrCreateSheet(spreadsheet, 'Favorites', MEMORY_HEADERS);
    migrateLegacySpots(spreadsheet, memoriesSheet);

    // Admin actions: Pages Functions has already checked that the session belongs to an
    // address listed in ADMIN_EMAILS; GAS additionally requires the valid session above.
    if (body.action === 'adminListUsers') {
      return jsonResponse(adminListUsers(usersSheet, pointsSheet, memoriesSheet));
    }
    if (body.action === 'adminUserDetail') {
      return jsonResponse(adminUserDetail(usersSheet, pointsSheet, memoriesSheet, body.userId));
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
    // Older app versions do not send lists.
    const lists = Array.isArray(incoming.lists) ? incoming.lists : [];
    if (points.length > 5000 || memories.length > 1000 || lists.length > 500) {
      throw new Error('This sync batch exceeds the allowed record count');
    }
    if (!points.every(isValidPoint) || !memories.every(isValidMemory)) {
      throw new Error('Sync contains an invalid location or spot');
    }
    if (!lists.every(isValidList)) {
      throw new Error('Sync contains an invalid favorite list');
    }

    const listsSheet = getOrCreateSheet(spreadsheet, 'Lists', LIST_HEADERS);
    mergePoints(user.sub, pointsSheet, points);
    mergeMemories(user.sub, memoriesSheet, memories, user.name);
    mergeLists(user.sub, listsSheet, lists);
    const userData = readUserData(user.sub, pointsSheet, memoriesSheet);
    userData.lists = readUserLists(user.sub, listsSheet);
    return jsonResponse({
      ok: true,
      data: userData,
      recommendations: readPublicMemories(user.sub, memoriesSheet)
    });
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
      decodeBase64UrlText(parts[0])
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
      decodeBase64UrlText(parts[1])
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

/**
 * Decodes an unpadded base64url string (as used in JWTs) to UTF-8 text.
 * Utilities.base64DecodeWebSafe may reject input without "=" padding, so pad it first.
 */
function decodeBase64UrlText(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]*$/.test(value)) {
    throw new Error('Invalid base64url value');
  }
  const padded = value + '===='.slice(0, (4 - (value.length % 4)) % 4);
  return Utilities.newBlob(Utilities.base64DecodeWebSafe(padded)).getDataAsString('UTF-8');
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
    0,
    '',
    0,
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

function requestPasswordReset(sheet, emailValue) {
  if (!isValidEmail(emailValue)) throw new Error('Email is invalid');
  // Checked before the user lookup so the answer does not depend on whether the address exists.
  if (MailApp.getRemainingDailyQuota() <= MAIL_QUOTA_RESERVE) {
    return { ok: false, code: 'MAIL_QUOTA_EXCEEDED' };
  }
  const user = findUserRow(sheet, emailValue);
  // Respond identically whether or not the address is registered.
  if (!user) return { ok: true };
  const now = Date.now();
  if (now - toTimestamp(user.values[12]) < RESET_RESEND_INTERVAL_MS) return { ok: true };

  const userId = String(user.values[0]);
  const code = generateResetCode();
  sheet.getRange(user.row, 10, 1, 4).setValues([[
    hashResetCode(userId, code),
    now + RESET_CODE_TTL_MS,
    0,
    now
  ]]);
  SpreadsheetApp.flush();

  const displayName = String(user.values[2]);
  MailApp.sendEmail({
    to: String(user.values[1]),
    subject: '【ashiato】パスワード再設定の確認コード',
    body: [
      displayName + ' 様',
      '',
      'ashiato のパスワード再設定が申請されました。',
      'アプリの再設定画面で、次のワンタイムパスワードを入力してください。',
      '',
      '    ワンタイムパスワード: ' + code,
      '',
      '有効期限は発行から' + (RESET_CODE_TTL_MS / 60000) + '分です。',
      'このコードは誰にも教えないでください。',
      '',
      'お心当たりがない場合は、このメールを破棄してください。パスワードは変更されません。'
    ].join('\n'),
    name: 'ashiato'
  });
  return { ok: true };
}

function confirmPasswordReset(sheet, body) {
  if (
    !isValidEmail(body.email) ||
    !/^[0-9]{6}$/.test(String(body.code || '')) ||
    !/^[A-Za-z0-9_-]{22}$/.test(body.passwordSalt || '') ||
    !/^[A-Za-z0-9_-]{43}$/.test(body.passwordHash || '')
  ) {
    throw new Error('Password reset data is invalid');
  }
  const user = findUserRow(sheet, body.email);
  if (!user) return { ok: false, code: 'RESET_INVALID' };

  const storedHash = String(user.values[9] || '');
  const expiresAt = toTimestamp(user.values[10]);
  const attempts = Number(user.values[11]) || 0;
  if (!storedHash || expiresAt <= Date.now() || attempts >= MAX_RESET_ATTEMPTS) {
    if (storedHash) sheet.getRange(user.row, 10, 1, 3).setValues([['', 0, 0]]);
    return { ok: false, code: 'RESET_INVALID' };
  }

  const userId = String(user.values[0]);
  if (!constantTimeEquals(hashResetCode(userId, body.code), storedHash)) {
    const nextAttempts = attempts + 1;
    if (nextAttempts >= MAX_RESET_ATTEMPTS) {
      sheet.getRange(user.row, 10, 1, 3).setValues([['', 0, 0]]);
    } else {
      sheet.getRange(user.row, 12).setValue(nextAttempts);
    }
    return { ok: false, code: 'RESET_INVALID' };
  }

  sheet.getRange(user.row, 4, 1, 2).setValues([[body.passwordSalt, body.passwordHash]]);
  sheet.getRange(user.row, 8, 1, 5).setValues([[0, 0, '', 0, 0]]);
  return {
    ok: true,
    user: {
      userId: userId,
      email: String(user.values[1]),
      displayName: String(user.values[2])
    }
  };
}

function generateResetCode() {
  // Utilities.getUuid() returns a random (v4) UUID; use 40 of its random bits.
  const hex = Utilities.getUuid().replace(/-/g, '').slice(0, 10);
  return String(parseInt(hex, 16) % 1000000).padStart(6, '0');
}

function hashResetCode(userId, code) {
  const secret = PropertiesService.getScriptProperties().getProperty('APP_SESSION_SECRET');
  if (!secret) throw new Error('APP_SESSION_SECRET is not configured');
  const bytes = Utilities.computeHmacSha256Signature('password-reset:' + userId + ':' + code, secret);
  return 'h:' + bytes.map(byte => ('0' + (byte & 0xff).toString(16)).slice(-2)).join('');
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
  } else {
    const columnCount = sheet.getLastColumn();
    const existingHeaders = columnCount
      ? sheet.getRange(1, 1, 1, columnCount).getValues()[0]
      : [];
    for (let index = 0; index < existingHeaders.length; index += 1) {
      if (existingHeaders[index] !== headers[index]) {
        throw new Error('Unexpected columns in the ' + name + ' sheet');
      }
    }
    if (existingHeaders.length < headers.length) {
      sheet.getRange(1, existingHeaders.length + 1, 1, headers.length - existingHeaders.length)
        .setValues([headers.slice(existingHeaders.length)]);
    }
  }
  return sheet;
}

function migrateLegacySpots(spreadsheet, favoritesSheet) {
  const legacySheet = spreadsheet.getSheetByName('Spots');
  if (!legacySheet || legacySheet.getLastRow() === 0) return;

  const legacyRows = readSheet(legacySheet);
  const legacyHeaders = legacyRows[0];
  if (
    legacyHeaders.length < LEGACY_SPOT_HEADERS.length ||
    LEGACY_SPOT_HEADERS.some((header, index) => legacyHeaders[index] !== header)
  ) {
    throw new Error('The legacy Spots sheet has unexpected columns and could not be migrated');
  }

  const existingKeys = new Set(
    readSheet(favoritesSheet).slice(1).map(row => String(row[0]) + ':' + String(row[1]))
  );
  const rowsToMigrate = [];
  legacyRows.slice(1).forEach(row => {
    const key = String(row[0]) + ':' + String(row[1]);
    if (existingKeys.has(key)) return;
    existingKeys.add(key);
    rowsToMigrate.push([
      row[0],
      row[1],
      row[2],
      row[3],
      row[4],
      row[5],
      row[6],
      row[7],
      row[8] || '',
      row[9] === true,
      row[10] || ''
    ]);
  });
  appendRows(favoritesSheet, rowsToMigrate);
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

function mergeMemories(userSub, sheet, memories, ownerName) {
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
      JSON.stringify(Array.isArray(memory.driveFiles) ? memory.driveFiles : []),
      memory.address || '',
      memory.isPublic === true,
      ownerName,
      memory.listId || '',
      memory.mark ? JSON.stringify({ symbol: memory.mark.symbol, color: memory.mark.color }) : ''
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
      driveFiles: parseDriveFiles(row[7]),
      address: String(row[8] || ''),
      isPublic: row[9] === true,
      listId: String(row[11] || ''),
      mark: parseMark(row[12])
    }));
  return { points: points, memories: memories };
}

/** Lists are stored per user; a row is replaced only by a newer version (updatedAt). */
function mergeLists(userSub, sheet, lists) {
  if (!lists.length) return;
  const rows = readSheet(sheet);
  const rowById = new Map();
  rows.slice(1).forEach((row, index) => {
    if (String(row[0]) === userSub) rowById.set(String(row[1]), { row: index + 2, updatedAt: toIsoString(row[5]) });
  });
  const newRows = [];
  lists.forEach(list => {
    const values = [
      userSub,
      list.id,
      list.name,
      JSON.stringify({ symbol: list.mark.symbol, color: list.mark.color }),
      list.createdAt,
      list.updatedAt,
      list.deletedAt || ''
    ];
    const existing = rowById.get(list.id);
    if (!existing) {
      newRows.push(values);
      rowById.set(list.id, { row: -1, updatedAt: list.updatedAt });
    } else if (existing.row > 0 && Date.parse(list.updatedAt) > Date.parse(existing.updatedAt)) {
      sheet.getRange(existing.row, 1, 1, values.length).setValues([values]);
    }
  });
  appendRows(sheet, newRows);
}

function readUserLists(userSub, sheet) {
  return readSheet(sheet).slice(1)
    .filter(row => String(row[0]) === userSub)
    .map(row => {
      const list = {
        id: String(row[1]),
        name: String(row[2]),
        mark: parseMark(row[3]) || { symbol: '♥', color: '#d78072' },
        createdAt: toIsoString(row[4]),
        updatedAt: toIsoString(row[5])
      };
      if (row[6]) list.deletedAt = toIsoString(row[6]);
      return list;
    });
}

function parseMark(value) {
  if (!value) return null;
  try {
    const mark = JSON.parse(String(value));
    return isValidMark(mark) ? { symbol: mark.symbol, color: mark.color } : null;
  } catch (error) {
    return null;
  }
}

function isValidMark(mark) {
  return mark && typeof mark === 'object' &&
    typeof mark.symbol === 'string' && mark.symbol.length > 0 && mark.symbol.length <= 8 &&
    typeof mark.color === 'string' && /^#[0-9a-f]{6}$/i.test(mark.color);
}

function isValidList(list) {
  return list && typeof list.id === 'string' && list.id.length > 0 && list.id.length <= 120 &&
    typeof list.name === 'string' && list.name.length > 0 && list.name.length <= 80 &&
    isValidMark(list.mark) &&
    typeof list.createdAt === 'string' && !isNaN(Date.parse(list.createdAt)) &&
    typeof list.updatedAt === 'string' && !isNaN(Date.parse(list.updatedAt)) &&
    (list.deletedAt === undefined || (typeof list.deletedAt === 'string' && !isNaN(Date.parse(list.deletedAt))));
}

function readPublicMemories(userSub, sheet) {
  return readSheet(sheet).slice(1)
    .filter(row => String(row[0]) !== userSub && row[9] === true)
    .map(row => ({
      id: String(row[1]),
      title: String(row[2]),
      note: String(row[3]),
      latitude: Number(row[4]),
      longitude: Number(row[5]),
      createdAt: toIsoString(row[6]),
      driveFiles: [],
      address: String(row[8] || ''),
      isPublic: true,
      ownerName: String(row[10] || 'ユーザー')
    }));
}

function adminUserSummary(row) {
  return {
    userId: String(row[0]),
    email: String(row[1]),
    displayName: String(row[2]),
    createdAt: row[5] ? toIsoString(row[5]) : '',
    lastLoginAt: row[6] ? toIsoString(row[6]) : '',
    failedAttempts: Number(row[7]) || 0,
    lockedUntil: toTimestamp(row[8])
  };
}

function adminListUsers(usersSheet, pointsSheet, memoriesSheet) {
  const stats = new Map();
  const statFor = userSub => {
    if (!stats.has(userSub)) {
      stats.set(userSub, { pointCount: 0, lastPointAt: '', favoriteCount: 0, publicFavoriteCount: 0 });
    }
    return stats.get(userSub);
  };
  readSheet(pointsSheet).slice(1).forEach(row => {
    const stat = statFor(String(row[0]));
    stat.pointCount += 1;
    const recordedAt = toIsoString(row[5]);
    if (recordedAt > stat.lastPointAt) stat.lastPointAt = recordedAt;
  });
  readSheet(memoriesSheet).slice(1).forEach(row => {
    const stat = statFor(String(row[0]));
    stat.favoriteCount += 1;
    if (row[9] === true) stat.publicFavoriteCount += 1;
  });

  const users = readSheet(usersSheet).slice(1)
    .filter(row => String(row[0]))
    .map(row => {
      const summary = adminUserSummary(row);
      const stat = stats.get(summary.userId) || statFor(summary.userId);
      return Object.assign(summary, stat);
    });
  return {
    ok: true,
    users: users,
    mailQuotaRemaining: MailApp.getRemainingDailyQuota(),
    mailQuotaReserve: MAIL_QUOTA_RESERVE
  };
}

function adminUserDetail(usersSheet, pointsSheet, memoriesSheet, userId) {
  if (typeof userId !== 'string' || !/^[a-f0-9-]{36}$/i.test(userId)) {
    throw new Error('User id is invalid');
  }
  const userRow = readSheet(usersSheet).slice(1).find(row => String(row[0]) === userId);
  if (!userRow) return { ok: false, code: 'USER_NOT_FOUND' };

  const data = readUserData(userId, pointsSheet, memoriesSheet);
  const points = data.points.sort((a, b) => (a.recordedAt < b.recordedAt ? 1 : a.recordedAt > b.recordedAt ? -1 : 0));
  return {
    ok: true,
    user: adminUserSummary(userRow),
    pointCount: points.length,
    points: points.slice(0, ADMIN_DETAIL_POINT_LIMIT),
    favorites: data.memories.map(memory => ({
      id: memory.id,
      title: memory.title,
      note: memory.note,
      address: memory.address,
      latitude: memory.latitude,
      longitude: memory.longitude,
      createdAt: memory.createdAt,
      isPublic: memory.isPublic,
      fileCount: memory.driveFiles.length
    }))
  };
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
    (memory.address === undefined || (typeof memory.address === 'string' && memory.address.length <= 300)) &&
    (memory.isPublic === undefined || typeof memory.isPublic === 'boolean') &&
    Number.isFinite(memory.latitude) && memory.latitude >= -90 && memory.latitude <= 90 &&
    Number.isFinite(memory.longitude) && memory.longitude >= -180 && memory.longitude <= 180 &&
    typeof memory.createdAt === 'string' && !isNaN(Date.parse(memory.createdAt)) &&
    Array.isArray(memory.driveFiles) && memory.driveFiles.length <= 100 &&
    memory.driveFiles.every(isValidDriveFile) &&
    (memory.listId === undefined || (typeof memory.listId === 'string' && memory.listId.length <= 120)) &&
    (memory.mark === undefined || memory.mark === null || isValidMark(memory.mark));
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
