// Phase 4 Riot Tournament Callback Unit Tests

function processRiotTournamentCallbackLocal(
  input: {
    token?: string;
    expectedToken?: string;
    body: {
      gameId: number;
      shortCode: string;
      startTime: number;
      metaData: string;
      gameName?: string;
      gameType?: string;
      gameMap?: number;
      gameMode?: string;
      region?: string;
    };
  },
  db: {
    matches: Record<string, any>;
    callbacks: Record<string, any>;
  }
) {
  if (input.expectedToken && input.token !== input.expectedToken) {
    return { success: false, statusCode: 403, reason: 'unauthorized', db };
  }

  const { gameId, shortCode, startTime, metaData } = input.body || {};

  if (!gameId || typeof gameId !== 'number' || gameId <= 0) {
    return { success: false, statusCode: 400, reason: 'invalid_game_id', db };
  }
  if (!shortCode || typeof shortCode !== 'string' || shortCode.trim() === '') {
    return { success: false, statusCode: 400, reason: 'invalid_short_code', db };
  }
  if (!startTime || typeof startTime !== 'number') {
    return { success: false, statusCode: 400, reason: 'invalid_start_time', db };
  }
  if (typeof metaData !== 'string') {
    return { success: false, statusCode: 400, reason: 'invalid_metadata', db };
  }

  let parsedMetadata: any = null;
  try {
    parsedMetadata = JSON.parse(metaData);
  } catch (e) {
    parsedMetadata = null;
  }

  // Find match by tournamentCode
  let matchedMatchId: string | null = null;
  const cleanCode = shortCode.trim();
  for (const [mId, mData] of Object.entries(db.matches)) {
    if (mData.tournamentCode === cleanCode) {
      matchedMatchId = mId;
      break;
    }
  }

  // Fallback to metaData.matchId if tournamentCode is missing on match doc
  if (!matchedMatchId && parsedMetadata?.matchId && db.matches[parsedMetadata.matchId]) {
    matchedMatchId = parsedMetadata.matchId;
  }

  const regionStr = input.body.region ? input.body.region.trim().toUpperCase() : 'KR';
  const docId = `${regionStr}_${gameId}`;

  // If no match found
  if (!matchedMatchId) {
    db.callbacks[docId] = {
      gameId,
      shortCode,
      matchedMatchId: null,
      processingStatus: 'blocked_match_not_found',
      blockReason: 'no_matching_tournament_code',
      duplicateCount: 1,
    };
    return {
      success: false,
      statusCode: 200,
      blocked: true,
      reason: 'blocked_match_not_found',
      matchedMatchId: null,
      db,
    };
  }

  // Idempotency check
  if (db.callbacks[docId]) {
    const existing = db.callbacks[docId];
    existing.duplicateCount = (existing.duplicateCount || 1) + 1;
    return {
      success: true,
      statusCode: 200,
      duplicate: true,
      matchedMatchId,
      db,
    };
  }

  // First time processing callback
  db.callbacks[docId] = {
    gameId,
    shortCode,
    matchedMatchId,
    processingStatus: 'received_matched',
    callbackReceived: true,
    duplicateCount: 1,
  };

  if (db.matches[matchedMatchId]) {
    db.matches[matchedMatchId].tournamentStatus = 'callback_received';
    db.matches[matchedMatchId].riotGameId = gameId;
    db.matches[matchedMatchId].callbackId = docId;
  }

  return {
    success: true,
    statusCode: 200,
    duplicate: false,
    matchedMatchId,
    db,
  };
}

console.log('============================================================');
console.log('Running StarGroup Phase 4 Riot Callback Integration Unit Tests');
console.log('============================================================');

let passedCount = 0;
let totalCount = 0;

function assert(condition: boolean, message: string) {
  totalCount++;
  if (condition) {
    passedCount++;
    console.log(`Test ${totalCount} (${message}): PASS`);
  } else {
    console.error(`Test ${totalCount} (${message}): FAIL`);
    process.exit(1);
  }
}

function createBaseDb() {
  return {
    matches: {
      'match-101': {
        id: 'match-101',
        tournamentCode: 'MOCK-KR-7766-123456',
        tournamentStatus: 'issued',
        tournamentId: 5501,
        providerId: 101,
      },
      'match-102': {
        id: 'match-102',
        tournamentCode: '',
        tournamentStatus: 'issued',
        tournamentId: 5502,
        providerId: 101,
      },
    },
    callbacks: {} as Record<string, any>,
  };
}

// Test 1: 정상 Callback 수신 및 Match 상태 업데이트
{
  const db = createBaseDb();
  const res = processRiotTournamentCallbackLocal(
    {
      expectedToken: 'secret123',
      token: 'secret123',
      body: {
        gameId: 889900,
        shortCode: 'MOCK-KR-7766-123456',
        startTime: 1700000000000,
        metaData: JSON.stringify({ matchId: 'match-101' }),
        region: 'KR',
      },
    },
    db
  );

  const m101 = res.db.matches['match-101'];
  const cbDoc = res.db.callbacks['KR_889900'];

  assert(
    res.success === true &&
      res.matchedMatchId === 'match-101' &&
      m101.tournamentStatus === 'callback_received' &&
      m101.riotGameId === 889900 &&
      m101.callbackId === 'KR_889900' &&
      cbDoc.processingStatus === 'received_matched',
    '정상 Callback 수신 & Match 상태 업데이트 (callback_received)'
  );
}

// Test 2: Tournament Code 정확한 매핑 검증
{
  const db = createBaseDb();
  const res = processRiotTournamentCallbackLocal(
    {
      expectedToken: 'secret123',
      token: 'secret123',
      body: {
        gameId: 889901,
        shortCode: '  MOCK-KR-7766-123456  ', // leading/trailing spaces
        startTime: 1700000000000,
        metaData: '',
        region: 'KR',
      },
    },
    db
  );

  assert(
    res.success === true && res.matchedMatchId === 'match-101',
    'Tournament Code 트림 및 exact 매핑 성공'
  );
}

// Test 3: 존재하지 않는 Tournament Code 안전 차단
{
  const db = createBaseDb();
  const res = processRiotTournamentCallbackLocal(
    {
      expectedToken: 'secret123',
      token: 'secret123',
      body: {
        gameId: 889902,
        shortCode: 'NON-EXISTENT-CODE-999',
        startTime: 1700000000000,
        metaData: '',
        region: 'KR',
      },
    },
    db
  );

  const cbDoc = res.db.callbacks['KR_889902'];

  assert(
    res.success === false &&
      res.blocked === true &&
      res.reason === 'blocked_match_not_found' &&
      cbDoc.processingStatus === 'blocked_match_not_found',
    '존재하지 않는 Tournament Code 안전 차단 (blocked_match_not_found)'
  );
}

// Test 4: 중복 Callback 멱등성 보장
{
  const db = createBaseDb();
  // First execution
  processRiotTournamentCallbackLocal(
    {
      expectedToken: 'secret123',
      token: 'secret123',
      body: {
        gameId: 889903,
        shortCode: 'MOCK-KR-7766-123456',
        startTime: 1700000000000,
        metaData: '',
        region: 'KR',
      },
    },
    db
  );

  // Second execution (duplicate)
  const dupRes = processRiotTournamentCallbackLocal(
    {
      expectedToken: 'secret123',
      token: 'secret123',
      body: {
        gameId: 889903,
        shortCode: 'MOCK-KR-7766-123456',
        startTime: 1700000000000,
        metaData: '',
        region: 'KR',
      },
    },
    db
  );

  const cbDoc = dupRes.db.callbacks['KR_889903'];

  assert(
    dupRes.success === true &&
      dupRes.duplicate === true &&
      cbDoc.duplicateCount === 2,
    '동일 Callback 재수신 시 멱등성 보장 (duplicateCount = 2)'
  );
}

// Test 5: metaData JSON fallback 매핑
{
  const db = createBaseDb();
  const res = processRiotTournamentCallbackLocal(
    {
      expectedToken: 'secret123',
      token: 'secret123',
      body: {
        gameId: 889904,
        shortCode: 'SOME-OTHER-CODE',
        startTime: 1700000000000,
        metaData: JSON.stringify({ matchId: 'match-102' }),
        region: 'KR',
      },
    },
    db
  );

  assert(
    res.success === true && res.matchedMatchId === 'match-102',
    'metaData JSON 내 matchId fallback 매핑 성공'
  );
}

// Test 6: 잘못된 비밀 토큰 차단
{
  const db = createBaseDb();
  const res = processRiotTournamentCallbackLocal(
    {
      expectedToken: 'secret123',
      token: 'wrongToken',
      body: {
        gameId: 889905,
        shortCode: 'MOCK-KR-7766-123456',
        startTime: 1700000000000,
        metaData: '',
        region: 'KR',
      },
    },
    db
  );

  assert(
    res.success === false && res.statusCode === 403 && res.reason === 'unauthorized',
    '잘못된 Secret Token 수신 시 403 Forbidden 차단'
  );
}

// Test 7: 필수 파라미터 누락 차단
{
  const db = createBaseDb();
  const res = processRiotTournamentCallbackLocal(
    {
      expectedToken: 'secret123',
      token: 'secret123',
      body: {
        gameId: 0, // invalid gameId
        shortCode: '',
        startTime: 1700000000000,
        metaData: '',
        region: 'KR',
      },
    },
    db
  );

  assert(
    res.success === false && res.statusCode === 400,
    'gameId/shortCode 누락 또는 유효하지 않은 값 수신 시 400 Bad Request 차단'
  );
}

console.log('============================================================');
console.log(`All ${passedCount}/${totalCount} Phase 4 Callback unit tests passed successfully!`);
console.log('============================================================');
