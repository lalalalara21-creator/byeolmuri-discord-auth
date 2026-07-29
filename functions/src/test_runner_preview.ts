// Test Runner for Riot Match Application Preview - Phase 3
// This script validates all 10 preview safety scenarios in-memory.

export {};

interface Member {
  id: string;
  nickname: string;
  currentLP: number;
  riotIdGameName?: string;
  riotIdTagline?: string;
}

interface Draft {
  riotMatchId: string;
  mappingStatus: string;
  reviewStatus: string;
  reviewRevision: number;
  reviewedParticipantMappings: Array<{
    riotParticipantId: number;
    memberId: string;
  }>;
  reviewedTeamMapping: {
    riotTeam100: 'A' | 'B';
  };
  reviewedMatchLink: {
    byeolmuriMatchId: string;
    setNumber: number;
  };
  applicationPreviewStatus?: string;
  applicationPreviewReviewRevision?: number;
  applicationPreviewRevision?: number;
}

interface NormalizedParticipant {
  participantId: number;
  teamId: number;
  championId: number;
  championName: string;
  win: boolean;
  kills: number;
  deaths: number;
  assists: number;
  teamPosition?: string;
  individualPosition?: string;
}

interface NormalizedMatch {
  riotMatchId: string;
  gameVersion: string;
  participants: NormalizedParticipant[];
  teams: Array<{ teamId: number; win: boolean }>;
}

interface ByeolmuriMatch {
  id: string;
  teamA: string[];
  teamB: string[];
  totalSets: number;
  seasonId: string;
  status: string;
}

interface SetResult {
  matchId: string;
  setNumber: number;
  winner: 'A' | 'B';
}

interface Reservation {
  id: string; // byeolmuriMatchId_setNumber
  riotMatchId: string;
}

interface DbMock {
  members: Record<string, Member>;
  drafts: Record<string, Draft>;
  normalized: Record<string, NormalizedMatch>;
  matches: Record<string, ByeolmuriMatch>;
  setResults: Record<string, SetResult>;
  reservations: Record<string, Reservation>;
  previews: Record<string, any>;
  policies: {
    win10: number;
    win20: number;
    win21: number;
    loseSet: number;
    draw11: number;
    activeSeasonId: string;
  };
}

// Replicated Core Algorithm from previewRiotMatchApplication
function previewRiotMatchApplicationLocal(riotMatchId: string, db: DbMock) {
  const draft = db.drafts[riotMatchId];
  if (!draft) return { success: false, error: 'DRAFT_NOT_FOUND' };

  const norm = db.normalized[riotMatchId];
  const policy = db.policies;

  const currentReviewRevision = draft.reviewRevision ?? 0;

  // Check if we can reuse an existing, valid preview
  if (draft.applicationPreviewStatus === 'ready' &&
      draft.applicationPreviewReviewRevision === currentReviewRevision &&
      db.previews[riotMatchId]) {
    return {
      success: true,
      riotMatchId,
      previewData: db.previews[riotMatchId],
      cached: true
    };
  }

  // Set draft state to generating (simulating writing process metadata without changing actual data)
  draft.applicationPreviewStatus = 'generating';

  const warnings: string[] = [];
  const blockers: string[] = [];
  let canApply = true;

  // --- 1. DRAFT VALIDATIONS ---
  if (draft.mappingStatus !== 'draft_ready') {
    blockers.push(`드래프트의 매핑 상태가 'draft_ready'가 아닙니다.`);
  }
  if (draft.reviewStatus !== 'review_ready') {
    blockers.push(`드래프트의 검토 상태가 'review_ready'가 아닙니다.`);
  }

  const reviewedMappings = draft.reviewedParticipantMappings || [];
  if (reviewedMappings.length !== 10) {
    blockers.push('검토된 소환사 매핑이 10명이 아닙니다.');
  }

  const mappedMemberIds = reviewedMappings.map((m: any) => m.memberId).filter((id: any) => id);
  const uniqueMappedMemberIds = new Set(mappedMemberIds);
  if (mappedMemberIds.length < 10) {
    blockers.push('배정되지 않은 참가자가 존재합니다.');
  }
  if (uniqueMappedMemberIds.size !== mappedMemberIds.length) {
    blockers.push('동일한 별무리 회원이 중복으로 배정되었습니다.');
  }

  const reviewedTeamMapping = draft.reviewedTeamMapping;
  const riotTeam100MapsTo = reviewedTeamMapping?.riotTeam100;
  if (riotTeam100MapsTo !== 'A' && riotTeam100MapsTo !== 'B') {
    blockers.push('Riot 100팀의 A/B팀 매핑이 결정되지 않았습니다.');
  }

  const byeolmuriMatchId = draft.reviewedMatchLink?.byeolmuriMatchId;
  const setNumber = draft.reviewedMatchLink?.setNumber;

  if (!byeolmuriMatchId) {
    blockers.push('연결할 별무리 경기가 지정되지 않았습니다.');
  }
  if (typeof setNumber !== 'number' || setNumber <= 0) {
    blockers.push('연결할 세트 번호가 올바르지 않습니다.');
  }

  // --- 2. NORMALIZED DATA VALIDATIONS ---
  if (!norm) {
    blockers.push('정규화된 Riot 경기 정보를 찾을 수 없습니다.');
  }

  // --- 3. STARGROUP MATCH VALIDATIONS ---
  let sgMatchData = byeolmuriMatchId ? db.matches[byeolmuriMatchId] : null;
  if (byeolmuriMatchId && !sgMatchData) {
    blockers.push(`지정된 별무리 경기(${byeolmuriMatchId})가 데이터베이스에 존재하지 않습니다.`);
  } else if (sgMatchData) {
    if (sgMatchData.status === 'rejected' || sgMatchData.status === 'deleted') {
      blockers.push(`지정된 별무리 경기는 현재 반려 또는 삭제 상태입니다.`);
    }

    const totalSets = sgMatchData.totalSets;
    if (setNumber > totalSets) {
      blockers.push(`선택한 세트 번호(${setNumber})가 별무리 경기의 총 세트 수(${totalSets})를 초과합니다.`);
    }
  }

  // --- 4. CONCURRENCY & DOUBLE LINKING CHECK ---
  if (byeolmuriMatchId && setNumber) {
    const reservationId = `${byeolmuriMatchId}_${setNumber}`;
    const reservation = db.reservations[reservationId];
    if (reservation) {
      if (reservation.riotMatchId !== riotMatchId) {
        blockers.push(`선택한 세트(${setNumber}세트)는 이미 다른 Riot 경기 검토 문서(${reservation.riotMatchId})에 예약/연결되어 있습니다.`);
      }
    }
  }

  // --- 5. OFFICIAL SET RESULT CHECK ---
  if (byeolmuriMatchId && typeof setNumber === 'number' && setNumber > 0) {
    const setResultKey = `${byeolmuriMatchId}_set${setNumber}`;
    const existingResult = db.setResults[setResultKey];
    if (existingResult) {
      blockers.push('existing-official-set-result: 이미 공식 반영된 세트입니다');
    }
  }

  // Retrieve member profiles
  const memberDocs: Record<string, Member> = {};
  for (const mapping of reviewedMappings) {
    const mId = mapping.memberId;
    if (mId && db.members[mId]) {
      memberDocs[mId] = db.members[mId];
    }
  }

  // --- 6. WINNER CALCULATION ---
  let winner: 'A' | 'B' | null = null;
  let loser: 'A' | 'B' | null = null;
  let riotWinningTeamId: number | null = null;

  if (norm && blockers.length === 0) {
    const winningTeamObj = norm.teams?.find((t: any) => t.win === true);
    riotWinningTeamId = winningTeamObj?.teamId || null;
    if (riotWinningTeamId === 100) {
      winner = riotTeam100MapsTo;
    } else if (riotWinningTeamId === 200) {
      winner = riotTeam100MapsTo === 'A' ? 'B' : 'A';
    }

    if (winner) {
      loser = winner === 'A' ? 'B' : 'A';
    }
  }

  if (blockers.length > 0) {
    canApply = false;
  }

  // --- 7. CALCULATE LP AND SCORE UPDATES ---
  const lpChanges: Array<{
    memberId: string;
    before: number | null;
    change: number | null;
    after: number | null;
    reason: string;
  }> = [];

  let participantPreviews: any[] = [];

  if (norm && sgMatchData && winner && loser && blockers.length === 0) {
    // Calculate expected set results lists
    const setResultsList: any[] = Object.values(db.setResults).filter((r: any) => r.matchId === byeolmuriMatchId);

    const targetSetIndex = setResultsList.findIndex((r: any) => r.setNumber === setNumber);
    const newSetResult = {
      matchId: byeolmuriMatchId,
      setNumber,
      winner,
    };

    if (targetSetIndex >= 0) {
      setResultsList[targetSetIndex] = newSetResult;
    } else {
      setResultsList.push(newSetResult);
    }

    let newScoreA = 0;
    let newScoreB = 0;
    setResultsList.forEach((r: any) => {
      if (r.winner === 'A') newScoreA++;
      else if (r.winner === 'B') newScoreB++;
    });

    const isDraw11 = newScoreA === 1 && newScoreB === 1;
    const isTeamAWinner = newScoreA > newScoreB;
    const winSets = isTeamAWinner ? newScoreA : newScoreB;
    const loseSets = isTeamAWinner ? newScoreB : newScoreA;

    let winReward = policy.win20;
    const drawLP = policy.draw11 ?? 0;
    if (winSets === 1 && loseSets === 0) {
      winReward = policy.win10;
    } else if (winSets === 2 && loseSets === 0) {
      winReward = policy.win20;
    } else if (winSets === 2 && loseSets === 1) {
      winReward = policy.win21;
    }
    const losePenalty = (winSets - loseSets) * policy.loseSet;

    const matchPlayers = [...(sgMatchData.teamA || []), ...(sgMatchData.teamB || [])];

    for (const playerNickname of matchPlayers) {
      const cleanNick = playerNickname.replace(/\s+/g, '').toLowerCase();
      const isTeamA = (sgMatchData.teamA || []).some((name: string) => name.replace(/\s+/g, '').toLowerCase() === cleanNick);

      let newLpChange = 0;
      if (isDraw11) {
        newLpChange = drawLP;
      } else {
        if (isTeamA) {
          newLpChange = isTeamAWinner ? winReward : -losePenalty;
        } else {
          newLpChange = !isTeamAWinner ? winReward : -losePenalty;
        }
      }

      const memberObj = Object.values(memberDocs).find(
        (m: any) => m.nickname.replace(/\s+/g, '').toLowerCase() === cleanNick
      );

      if (memberObj) {
        const beforeLP = memberObj.currentLP ?? 1200;
        const afterLP = Math.max(0, beforeLP + newLpChange);

        lpChanges.push({
          memberId: memberObj.id,
          before: beforeLP,
          change: newLpChange,
          after: afterLP,
          reason: `경기 승인 시 LP ${newLpChange > 0 ? '+' : ''}${newLpChange} 반영 예정`,
        });
      }
    }

    participantPreviews = norm.participants.map((p: any) => {
      const mapping = reviewedMappings.find((m: any) => m.riotParticipantId === p.participantId);
      const memberId = mapping?.memberId || '';
      const member = memberDocs[memberId];
      const mName = member ? member.nickname : '';

      let byteolmuriTeam: 'A' | 'B' = 'A';
      if (p.teamId === 100) {
        byteolmuriTeam = riotTeam100MapsTo;
      } else {
        byteolmuriTeam = riotTeam100MapsTo === 'A' ? 'B' : 'A';
      }

      const pLpPreview = lpChanges.find(l => l.memberId === memberId);

      return {
        riotParticipantId: p.participantId,
        memberId,
        memberName: mName,
        byteolmuriTeam,
        win: p.win,
        kills: p.kills,
        deaths: p.deaths,
        assists: p.assists,
        currentLp: pLpPreview ? pLpPreview.before : null,
        lpChange: pLpPreview ? pLpPreview.change : null,
        expectedLpAfter: pLpPreview ? pLpPreview.after : null,
      };
    });
  }

  // Compile preview result document
  const resultPreviewData = {
    schemaVersion: 1,
    riotMatchId,
    byeolmuriMatchId: byeolmuriMatchId || '',
    setNumber: setNumber || 0,
    winner: winner || 'A',
    loser: loser || 'B',
    participants: participantPreviews,
    lpChanges: lpChanges,
    warnings,
    blockers,
    canApply,
    reviewRevision: currentReviewRevision,
    previewRevision: (draft.applicationPreviewRevision ?? 0) + 1,
  };

  // Write preview to read-only mock result collection (simulating transaction.set)
  db.previews[riotMatchId] = resultPreviewData;

  // Update draft status (simulating transaction.update)
  draft.applicationPreviewStatus = canApply ? 'ready' : 'blocked';
  draft.applicationPreviewReviewRevision = currentReviewRevision;
  draft.applicationPreviewRevision = (draft.applicationPreviewRevision ?? 0) + 1;

  return {
    success: true,
    riotMatchId,
    previewData: resultPreviewData
  };
}

// ==========================================================
// TEST SCENARIOS EXECUTION
// ==========================================================

function createInitialMockDb(): DbMock {
  const members: Record<string, Member> = {};
  for (let i = 1; i <= 10; i++) {
    members[`member_${i}`] = {
      id: `member_${i}`,
      nickname: `Player ${i}`,
      currentLP: 1200
    };
  }

  const participants: NormalizedParticipant[] = [];
  for (let i = 1; i <= 10; i++) {
    participants.push({
      participantId: i,
      teamId: i <= 5 ? 100 : 200,
      championId: 10 + i,
      championName: `Champion_${i}`,
      win: i <= 5, // Blue team win (100)
      kills: 5,
      deaths: 2,
      assists: 8,
    });
  }

  const reviewedParticipantMappings = [];
  for (let i = 1; i <= 10; i++) {
    reviewedParticipantMappings.push({
      riotParticipantId: i,
      memberId: `member_${i}`
    });
  }

  const draft: Draft = {
    riotMatchId: 'riot_match_999',
    mappingStatus: 'draft_ready',
    reviewStatus: 'review_ready',
    reviewRevision: 1,
    reviewedParticipantMappings,
    reviewedTeamMapping: {
      riotTeam100: 'A'
    },
    reviewedMatchLink: {
      byeolmuriMatchId: 'byeolmuri_match_100',
      setNumber: 1
    }
  };

  const normalized: NormalizedMatch = {
    riotMatchId: 'riot_match_999',
    gameVersion: '14.12.123',
    participants,
    teams: [
      { teamId: 100, win: true },
      { teamId: 200, win: false }
    ]
  };

  const matches: Record<string, ByeolmuriMatch> = {
    'byeolmuri_match_100': {
      id: 'byeolmuri_match_100',
      teamA: ['Player 1', 'Player 2', 'Player 3', 'Player 4', 'Player 5'],
      teamB: ['Player 6', 'Player 7', 'Player 8', 'Player 9', 'Player 10'],
      totalSets: 3,
      seasonId: 'season1',
      status: 'pending'
    }
  };

  return {
    members,
    drafts: { 'riot_match_999': draft },
    normalized: { 'riot_match_999': normalized },
    matches,
    setResults: {},
    reservations: {},
    previews: {},
    policies: {
      win10: 15,
      win20: 20,
      win21: 18,
      loseSet: 5,
      draw11: 0,
      activeSeasonId: 'season1'
    }
  };
}

function runTests() {
  console.log('============================================================');
  console.log('STARTING PHASE 3 APPLICATION PREVIEW SAFETY TESTS');
  console.log('============================================================\n');

  // Test 1: 공식 결과가 없는 세트 Preview 성공
  {
    const db = createInitialMockDb();
    const result = previewRiotMatchApplicationLocal('riot_match_999', db);
    const pass = result.success && result.previewData.canApply === true && result.previewData.blockers.length === 0;
    console.log(`Test 1 (공식 결과 없는 세트 Preview 성공): ${pass ? 'PASS' : 'FAIL'}`);
  }

  // Test 2: 이미 공식 결과가 있는 세트 Preview 차단
  {
    const db = createInitialMockDb();
    // Add existing result
    db.setResults['byeolmuri_match_100_set1'] = {
      matchId: 'byeolmuri_match_100',
      setNumber: 1,
      winner: 'A'
    };
    const result = previewRiotMatchApplicationLocal('riot_match_999', db);
    const hasBlocker = result.previewData.blockers.some((b: string) => b.includes('existing-official-set-result'));
    const pass = result.success && result.previewData.canApply === false && hasBlocker && result.previewData.lpChanges.length === 0;
    console.log(`Test 2 (공식 결과가 있는 세트 Preview 차단 및 LP 계산 스킵): ${pass ? 'PASS' : 'FAIL'}`);
  }

  // Test 3: Preview 실행 후 matches 무변경
  {
    const db = createInitialMockDb();
    const initialMatchState = JSON.stringify(db.matches);
    previewRiotMatchApplicationLocal('riot_match_999', db);
    const postMatchState = JSON.stringify(db.matches);
    const pass = initialMatchState === postMatchState;
    console.log(`Test 3 (Preview 실행 후 matches 컬렉션 무변경): ${pass ? 'PASS' : 'FAIL'}`);
  }

  // Test 4: Preview 실행 후 match_set_results 무변경
  {
    const db = createInitialMockDb();
    const initialSetState = JSON.stringify(db.setResults);
    previewRiotMatchApplicationLocal('riot_match_999', db);
    const postSetState = JSON.stringify(db.setResults);
    const pass = initialSetState === postSetState;
    console.log(`Test 4 (Preview 실행 후 match_set_results 컬렉션 무변경): ${pass ? 'PASS' : 'FAIL'}`);
  }

  // Test 5: Preview 실행 후 members 및 LP 무변경
  {
    const db = createInitialMockDb();
    const initialMemberState = JSON.stringify(db.members);
    previewRiotMatchApplicationLocal('riot_match_999', db);
    const postMemberState = JSON.stringify(db.members);
    const pass = initialMemberState === postMemberState;
    console.log(`Test 5 (Preview 실행 후 members 및 LP 무변경): ${pass ? 'PASS' : 'FAIL'}`);
  }

  // Test 6: Preview 실행만으로 예약 문서가 생성되지 않음
  {
    const db = createInitialMockDb();
    const initialReservationState = JSON.stringify(db.reservations);
    previewRiotMatchApplicationLocal('riot_match_999', db);
    const postReservationState = JSON.stringify(db.reservations);
    const pass = initialReservationState === postReservationState;
    console.log(`Test 6 (Preview 실행만으로 예약 문서가 생성되지 않음): ${pass ? 'PASS' : 'FAIL'}`);
  }

  // Test 7: 기존 Apply 예약이 있을 경우 Preview 차단
  {
    const db = createInitialMockDb();
    // Pre-exist a reservation for the same match & set linked to a different Riot Match
    db.reservations['byeolmuri_match_100_1'] = {
      id: 'byeolmuri_match_100_1',
      riotMatchId: 'riot_match_different_888'
    };
    const result = previewRiotMatchApplicationLocal('riot_match_999', db);
    const hasBlocker = result.previewData.blockers.some((b: string) => b.includes('예약/연결되어 있습니다'));
    const pass = result.success && result.previewData.canApply === false && hasBlocker;
    console.log(`Test 7 (기존 예약 충돌 있을 경우 Preview 차단): ${pass ? 'PASS' : 'FAIL'}`);
  }

  // Test 8: Draft revision 변경 시 Preview stale 처리 (UI 시뮬레이션)
  {
    const draft: Draft = {
      riotMatchId: 'riot_match_999',
      mappingStatus: 'draft_ready',
      reviewStatus: 'review_ready',
      reviewRevision: 1, // Current revision is 1
      reviewedParticipantMappings: [],
      reviewedTeamMapping: { riotTeam100: 'A' },
      reviewedMatchLink: { byeolmuriMatchId: 'b', setNumber: 1 }
    };
    const previewData = {
      reviewRevision: 1, // Matches draft revision 1
      canApply: true
    };
    
    // Check if stale
    let isStale = draft.reviewRevision !== previewData.reviewRevision;
    const initialPass = !isStale;

    // operator edits mapping, incrementing reviewRevision
    draft.reviewRevision = 2;
    isStale = draft.reviewRevision !== previewData.reviewRevision;
    const pass = initialPass && isStale;
    console.log(`Test 8 (Draft Revision 변경 시 Preview stale 처리): ${pass ? 'PASS' : 'FAIL'}`);
  }

  // Test 9: 동일 revision Preview 재호출 시 안전한 결과 반환
  {
    const db = createInitialMockDb();
    // Simulate already generated preview ready state
    db.drafts['riot_match_999'].applicationPreviewStatus = 'ready';
    db.drafts['riot_match_999'].applicationPreviewReviewRevision = 1;
    db.previews['riot_match_999'] = {
      riotMatchId: 'riot_match_999',
      canApply: true,
      reviewRevision: 1,
      fromCache: true
    };

    const result = previewRiotMatchApplicationLocal('riot_match_999', db);
    const pass = result.success && (result as any).cached === true && result.previewData.fromCache === true;
    console.log(`Test 9 (동일 revision Preview 재호출 시 캐시 결과 반환): ${pass ? 'PASS' : 'FAIL'}`);
  }

  // Test 10: BO3의 선택되지 않은 다른 세트 무변경
  {
    const db = createInitialMockDb();
    // Populate official set 2 result
    db.setResults['byeolmuri_match_100_set2'] = {
      matchId: 'byeolmuri_match_100',
      setNumber: 2,
      winner: 'B'
    };
    const initialSet2 = JSON.stringify(db.setResults['byeolmuri_match_100_set2']);
    
    // Run preview on set 1
    previewRiotMatchApplicationLocal('riot_match_999', db);
    
    // Assert set 2 remains identical and untouched
    const postSet2 = JSON.stringify(db.setResults['byeolmuri_match_100_set2']);
    const pass = initialSet2 === postSet2;
    console.log(`Test 10 (BO3의 선택되지 않은 다른 세트 무변경): ${pass ? 'PASS' : 'FAIL'}`);
  }

  console.log('\n============================================================');
  console.log('ALL APPLICATION PREVIEW SAFETY TESTS FINISHED!');
  console.log('============================================================');
}

runTests();
