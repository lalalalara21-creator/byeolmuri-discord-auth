import * as functions from 'firebase-functions';
import * as admin from 'firebase-admin';
import { defineSecret } from 'firebase-functions/params';

// Define secrets required for Riot API interactions
export const riotApiKeySecret = defineSecret('RIOT_API_KEY');

// ==========================================
// Types & Interfaces
// ==========================================

export interface RiotAccountV1Response {
  puuid: string;
  gameName: string;
  tagLine: string;
}

export interface SummonerV4Response {
  id: string;
  accountId: string;
  puuid: string;
  profileIconId: number;
  revisionDate: number;
  summonerLevel: number;
  name?: string;
}

export interface RiotAccountLinkPayload {
  memberId: string;
  riotIdStr: string; // e.g. "Hide on bush#KR1"
}

export interface ParticipantMappingInput {
  riotParticipantId: number;
  memberId: string | null;
}

export interface SaveRiotMappingReviewData {
  riotMatchId: string;
  saveMode?: 'draft' | 'complete';
  isReviewComplete?: boolean;
  participantMappings: ParticipantMappingInput[];
  riot100MapsTo?: 'A' | 'B';
  byeolmuriMatchId?: string;
  setNumber?: number;
  expectedReviewRevision?: number;
}

// ==========================================
// Validation & Utility Helpers
// ==========================================

/**
 * Cleans whitespace and normalizes string to lowercase for exact comparison.
 */
export const cleanAndNormalizeString = (str: string | null | undefined): string => {
  if (!str) return '';
  return str.replace(/\s+/g, '').toLowerCase();
};

/**
 * Parses a Riot ID string into gameName and tagLine.
 * Default tagLine is 'KR1' if omitted or if format is just gameName.
 */
export function parseRiotId(riotIdStr: string): { gameName: string; tagLine: string } | null {
  if (!riotIdStr || typeof riotIdStr !== 'string') return null;
  const trimmed = riotIdStr.trim();
  if (!trimmed) return null;

  const parts = trimmed.split('#');
  if (parts.length === 1) {
    return {
      gameName: parts[0].trim(),
      tagLine: 'KR1',
    };
  } else if (parts.length === 2) {
    const gameName = parts[0].trim();
    const tagLine = parts[1].trim();
    if (!gameName || !tagLine) return null;
    return { gameName, tagLine };
  }
  return null;
}

/**
 * Validates whether gameName and tagLine satisfy standard Riot ID format requirements.
 */
export function validateRiotId(gameName: string, tagLine: string): boolean {
  if (!gameName || !tagLine) return false;
  if (gameName.length < 3 || gameName.length > 16) return false;
  if (tagLine.length < 3 || tagLine.length > 5) return false;
  return true;
}

// ==========================================
// Riot API Helper Functions
// ==========================================

/**
 * Calls Riot Account-v1 API to look up PUUID by Riot ID (gameName#tagLine).
 */
export async function fetchRiotAccountByRiotId(
  gameName: string,
  tagLine: string,
  apiKey: string
): Promise<RiotAccountV1Response | null> {
  const regionCluster = 'asia';
  const url = `https://${regionCluster}.api.riotgames.com/riot/account/v1/accounts/by-riot-id/${encodeURIComponent(gameName)}/${encodeURIComponent(tagLine)}`;

  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'X-Riot-Token': apiKey,
        'Accept': 'application/json',
      },
    });

    if (response.status === 404) return null;
    if (!response.ok) {
      functions.logger.error(`Riot Account-v1 API HTTP ${response.status} for ${gameName}#${tagLine}`);
      return null;
    }

    return (await response.json()) as RiotAccountV1Response;
  } catch (err: any) {
    functions.logger.error(`Exception in fetchRiotAccountByRiotId for ${gameName}#${tagLine}`, err);
    return null;
  }
}

/**
 * Calls Summoner-v4 API to look up summoner info by PUUID.
 */
export async function fetchSummonerByPuuid(
  puuid: string,
  apiKey: string
): Promise<SummonerV4Response | null> {
  const region = 'kr';
  const url = `https://${region}.api.riotgames.com/lol/summoner/v4/summoners/by-puuid/${encodeURIComponent(puuid)}`;

  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'X-Riot-Token': apiKey,
        'Accept': 'application/json',
      },
    });

    if (response.status === 404) return null;
    if (!response.ok) {
      functions.logger.error(`Summoner-v4 API HTTP ${response.status} for puuid: ${puuid}`);
      return null;
    }

    return (await response.json()) as SummonerV4Response;
  } catch (err: any) {
    functions.logger.error(`Exception in fetchSummonerByPuuid for puuid: ${puuid}`, err);
    return null;
  }
}

// ==========================================
// Riot Account Linking Logic
// ==========================================

/**
 * Verifies Riot ID via Riot Account-v1 and Summoner-v4, ensures no duplicate PUUID across members,
 * and updates member document in Firestore.
 */
export async function linkRiotAccountToMember(
  memberId: string,
  gameName: string,
  tagLine: string,
  apiKey: string
): Promise<{ success: boolean; message?: string; data?: any }> {
  // 1. Fetch Riot Account
  const account = await fetchRiotAccountByRiotId(gameName, tagLine, apiKey);
  if (!account) {
    return { success: false, message: '해당 Riot ID(게임이름#태그)를 찾을 수 없습니다.' };
  }

  const { puuid, gameName: officialGameName, tagLine: officialTagLine } = account;

  // 2. Fetch Summoner Info
  const summoner = await fetchSummonerByPuuid(puuid, apiKey);

  // 3. Duplicate PUUID check across members using Firestore transaction
  const memberRef = admin.firestore().collection('members').doc(memberId);

  try {
    const transactionResult = await admin.firestore().runTransaction(async (tx) => {
      const memberDoc = await tx.get(memberRef);
      if (!memberDoc.exists) {
        throw new Error('MEMBER_NOT_FOUND');
      }

      // Query if another member already has this PUUID
      const existingQuery = await admin.firestore()
        .collection('members')
        .where('puuid', '==', puuid)
        .get();

      const duplicateDocs = existingQuery.docs.filter(d => d.id !== memberId);
      if (duplicateDocs.length > 0) {
        throw new Error('DUPLICATE_PUUID');
      }

      const updateData = {
        puuid,
        riotIdGameName: officialGameName,
        riotIdTagline: officialTagLine,
        summonerId: summoner?.id || null,
        summonerName: summoner?.name || officialGameName,
        summonerLevel: summoner?.summonerLevel || null,
        profileIconId: summoner?.profileIconId || null,
        riotAccountLinkedAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      };

      tx.update(memberRef, updateData);

      return {
        puuid,
        riotIdGameName: officialGameName,
        riotIdTagline: officialTagLine,
        summonerId: summoner?.id || null,
        summonerName: summoner?.name || officialGameName,
        summonerLevel: summoner?.summonerLevel || null,
      };
    });

    return {
      success: true,
      message: 'Riot 계정이 성공적으로 연동되었습니다.',
      data: transactionResult,
    };
  } catch (err: any) {
    if (err.message === 'MEMBER_NOT_FOUND') {
      return { success: false, message: '해당 회원 문서를 찾을 수 없습니다.' };
    }
    if (err.message === 'DUPLICATE_PUUID') {
      return { success: false, message: '이미 다른 회원에게 연동되어 있는 Riot 계정입니다.' };
    }
    functions.logger.error(`Error in linkRiotAccountToMember for memberId ${memberId}`, err);
    return { success: false, message: `계정 연동 실패: ${err.message || '서버 오류'}` };
  }
}

/**
 * Callable Cloud Function: verifyAndLinkRiotAccount
 * Secure Callable trigger to verify and link a Riot Account to a StarGroup member.
 */
export const verifyAndLinkRiotAccount = functions
  .runWith({
    secrets: [riotApiKeySecret],
  })
  .https.onCall(async (data, context) => {
    if (!context.auth) {
      throw new functions.https.HttpsError('unauthenticated', '인증이 필요합니다.');
    }

    const { memberId, riotIdStr } = data || {};
    if (!memberId || typeof memberId !== 'string') {
      throw new functions.https.HttpsError('invalid-argument', '유효한 memberId가 필요합니다.');
    }

    const parsed = parseRiotId(riotIdStr);
    if (!parsed) {
      throw new functions.https.HttpsError('invalid-argument', '유효한 Riot ID (게임이름#태그) 형식이어야 합니다.');
    }

    const apiKey = riotApiKeySecret.value();
    if (!apiKey) {
      throw new functions.https.HttpsError('internal', 'Riot API 키가 설정되지 않았습니다.');
    }

    const result = await linkRiotAccountToMember(memberId, parsed.gameName, parsed.tagLine, apiKey);
    if (!result.success) {
      throw new functions.https.HttpsError('invalid-argument', result.message || '연동 실패');
    }

    return result;
  });

// ==========================================
// Member Mapping Draft & Review Logic
// ==========================================

/**
 * Core helper function to create member mapping draft for a normalized Riot match.
 */
export async function createRiotMemberMappingDraftCore(callbackId: string) {
  const callbackDocRef = admin.firestore().collection('riot_tournament_callbacks').doc(callbackId);

  try {
    const lockResult = await admin.firestore().runTransaction(async (transaction) => {
      const callbackSnapshot = await transaction.get(callbackDocRef);
      if (!callbackSnapshot.exists) {
        return { alreadyDone: false, failed: true, reason: 'not_found' };
      }

      const callbackData = callbackSnapshot.data()!;
      const processingStatus = callbackData.processingStatus;
      const currentMappingStatus = callbackData.mappingStatus || 'not_started';
      const riotMatchId = callbackData.riotMatchId;

      if (processingStatus !== 'verified' || !riotMatchId) {
        return { alreadyDone: false, failed: true, reason: 'not_verified' };
      }

      if (currentMappingStatus === 'draft_ready') {
        return {
          alreadyDone: true,
          failed: false,
          riotMatchId,
          draftPath: callbackData.mappingDraftPath || `riot_match_mapping_drafts/${riotMatchId}`,
        };
      }

      transaction.update(callbackDocRef, {
        mappingStatus: 'mapping',
        mappingStartedAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      return {
        alreadyDone: false,
        failed: false,
        riotMatchId,
        callbackData,
      };
    });

    if (lockResult.failed) {
      return { success: false, errorCode: lockResult.reason || 'lock_failed' };
    }

    if (lockResult.alreadyDone) {
      return {
        success: true,
        riotMatchId: lockResult.riotMatchId,
        draftPath: lockResult.draftPath,
      };
    }

    const { riotMatchId, callbackData } = lockResult;

    const normalizedMatchDocRef = admin.firestore().collection('riot_match_normalized').doc(riotMatchId!);
    const normalizedMatchSnapshot = await normalizedMatchDocRef.get();

    if (!normalizedMatchSnapshot.exists) {
      await callbackDocRef.update({
        mappingStatus: 'mapping_failed',
        mappingErrorCode: 'normalized_match_not_found',
        mappingFailedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
      return { success: false, errorCode: 'normalized_match_not_found' };
    }

    const normalizedMatchData = normalizedMatchSnapshot.data()!;
    const gameId = normalizedMatchData.gameId;
    const participants = normalizedMatchData.participants || [];

    const membersSnap = await admin.firestore().collection('members').get();
    const membersList = membersSnap.docs.map(doc => ({
      id: doc.id,
      ...doc.data()
    })) as any[];

    let starGroupMatchData: any = null;
    const starGroupMatchId = callbackData?.parsedMetadata?.matchId || callbackData?.parsedMetadata?.starGroupMatchId;

    if (starGroupMatchId) {
      const sgMatchSnapshot = await admin.firestore().collection('matches').doc(starGroupMatchId).get();
      if (sgMatchSnapshot.exists) {
        starGroupMatchData = sgMatchSnapshot.data();
      }
    }

    const cleanTeamANicknames = new Set<string>();
    const cleanTeamBNicknames = new Set<string>();
    if (starGroupMatchData) {
      (starGroupMatchData.teamA || []).forEach((n: string) => cleanTeamANicknames.add(cleanAndNormalizeString(n)));
      (starGroupMatchData.teamB || []).forEach((n: string) => cleanTeamBNicknames.add(cleanAndNormalizeString(n)));
    }

    const mappedParticipants: any[] = [];

    for (const p of participants) {
      const candidates: { member: any; reason: string }[] = [];

      for (const m of membersList) {
        let matchedByPuuid = false;
        let matchedByRiotId = false;
        let matchedByNickname = false;
        let matchedBySummoner = false;

        if (m.puuid && p.puuid && m.puuid === p.puuid) matchedByPuuid = true;

        if (m.riotIdGameName && m.riotIdTagline) {
          if (cleanAndNormalizeString(m.riotIdGameName) === cleanAndNormalizeString(p.riotIdGameName) &&
              cleanAndNormalizeString(m.riotIdTagline) === cleanAndNormalizeString(p.riotIdTagline)) {
            matchedByRiotId = true;
          }
        }

        const mNicknameClean = cleanAndNormalizeString(m.nickname);
        const pRiotIdGameNameClean = cleanAndNormalizeString(p.riotIdGameName);
        const pSummonerNameClean = p.summonerName ? cleanAndNormalizeString(p.summonerName) : '';

        if (mNicknameClean && (mNicknameClean === pRiotIdGameNameClean || (pSummonerNameClean && mNicknameClean === pSummonerNameClean))) {
          matchedByNickname = true;
        }

        if (m.summonerName) {
          const mSummonerClean = cleanAndNormalizeString(m.summonerName);
          if (mSummonerClean && (mSummonerClean === pRiotIdGameNameClean || (pSummonerNameClean && mSummonerClean === pSummonerNameClean))) {
            matchedBySummoner = true;
          }
        }

        if (matchedByPuuid) {
          candidates.push({ member: m, reason: 'puuid_match' });
        } else if (matchedByRiotId) {
          candidates.push({ member: m, reason: 'riot_id_match' });
        } else if (matchedByNickname) {
          const isRoster = cleanTeamANicknames.has(mNicknameClean) || cleanTeamBNicknames.has(mNicknameClean);
          candidates.push({ member: m, reason: isRoster ? 'roster_candidate' : 'nickname_candidate' });
        } else if (matchedBySummoner) {
          const isRoster = cleanTeamANicknames.has(mNicknameClean) || cleanTeamBNicknames.has(mNicknameClean);
          candidates.push({ member: m, reason: isRoster ? 'roster_candidate' : 'summoner_name_candidate' });
        }
      }

      const puuidMatches = candidates.filter(c => c.reason === 'puuid_match');
      const riotIdMatches = candidates.filter(c => c.reason === 'riot_id_match');

      let matchedMemberId: string | null = null;
      let matchedMemberName: string | null = null;
      let matchStatus: 'exact_puuid' | 'exact_riot_id' | 'multiple_candidates' | 'not_found' | 'conflict' = 'not_found';
      let confidence: 'confirmed' | 'high' | 'needs_review' = 'needs_review';
      const matchReasons: string[] = [];
      const candidateMemberIds: string[] = [];

      candidates.forEach(c => {
        if (!candidateMemberIds.includes(c.member.id)) candidateMemberIds.push(c.member.id);
        if (!matchReasons.includes(c.reason)) matchReasons.push(c.reason);
      });

      if (puuidMatches.length === 1) {
        matchedMemberId = puuidMatches[0].member.id;
        matchedMemberName = puuidMatches[0].member.nickname;
        matchStatus = 'exact_puuid';
        confidence = 'confirmed';
      } else if (puuidMatches.length > 1) {
        matchStatus = 'conflict';
        confidence = 'needs_review';
      } else if (riotIdMatches.length === 1) {
        matchedMemberId = riotIdMatches[0].member.id;
        matchedMemberName = riotIdMatches[0].member.nickname;
        matchStatus = 'exact_riot_id';
        confidence = 'high';
      } else if (riotIdMatches.length > 1) {
        matchStatus = 'conflict';
        confidence = 'needs_review';
      } else if (candidates.length > 0) {
        matchStatus = 'multiple_candidates';
        confidence = 'needs_review';
      }

      mappedParticipants.push({
        riotParticipantId: p.participantId,
        puuid: p.puuid,
        summonerId: p.summonerId,
        summonerName: p.summonerName,
        riotIdGameName: p.riotIdGameName,
        riotIdTagline: p.riotIdTagline,
        teamId: p.teamId,
        championId: p.championId,
        championName: p.championName,
        matchedMemberId,
        matchedMemberName,
        matchStatus,
        confidence,
        matchReasons,
        candidateMemberIds,
      });
    }

    let proposedRiotTeam100: 'A' | 'B' | null = null;
    let proposedRiotTeam200: 'A' | 'B' | null = null;
    let teamMappingStatus: 'confirmed' | 'probable' | 'needs_review' = 'needs_review';

    let votes100ToA = 0;
    let votes100ToB = 0;
    let votes200ToA = 0;
    let votes200ToB = 0;

    for (const mp of mappedParticipants) {
      if (!mp.matchedMemberName) continue;
      const cleanNick = cleanAndNormalizeString(mp.matchedMemberName);

      if (mp.teamId === 100) {
        if (cleanTeamANicknames.has(cleanNick)) votes100ToA++;
        if (cleanTeamBNicknames.has(cleanNick)) votes100ToB++;
      } else if (mp.teamId === 200) {
        if (cleanTeamANicknames.has(cleanNick)) votes200ToA++;
        if (cleanTeamBNicknames.has(cleanNick)) votes200ToB++;
      }
    }

    const score100ToA_200ToB = votes100ToA + votes200ToB;
    const score100ToB_200ToA = votes100ToB + votes200ToA;

    if (score100ToA_200ToB > score100ToB_200ToA) {
      proposedRiotTeam100 = 'A';
      proposedRiotTeam200 = 'B';
    } else if (score100ToB_200ToA > score100ToA_200ToB) {
      proposedRiotTeam100 = 'B';
      proposedRiotTeam200 = 'A';
    } else {
      proposedRiotTeam100 = 'A';
      proposedRiotTeam200 = 'B';
    }

    const mappedCount = mappedParticipants.filter(mp => mp.matchedMemberId !== null).length;
    const hasConflict = mappedParticipants.some(mp => mp.matchStatus === 'conflict');

    if (starGroupMatchData === null || hasConflict) {
      teamMappingStatus = 'needs_review';
    } else if (mappedCount === 10) {
      const isPerfectD1 = (votes100ToA === 5 && votes200ToB === 5);
      const isPerfectD2 = (votes100ToB === 5 && votes200ToA === 5);
      teamMappingStatus = (isPerfectD1 || isPerfectD2) ? 'confirmed' : 'needs_review';
    } else if (mappedCount >= 8) {
      teamMappingStatus = (score100ToA_200ToB !== score100ToB_200ToA) ? 'probable' : 'needs_review';
    } else {
      teamMappingStatus = 'needs_review';
    }

    const draftDocRef = admin.firestore().collection('riot_match_mapping_drafts').doc(riotMatchId!);

    await admin.firestore().runTransaction(async (writeTx) => {
      const draftData = {
        riotMatchId,
        callbackId,
        gameId,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        mappingStatus: 'draft_ready',
        participants: mappedParticipants,
        teamMapping: {
          status: teamMappingStatus,
          riotTeam100: proposedRiotTeam100,
          riotTeam200: proposedRiotTeam200,
        },
      };

      writeTx.set(draftDocRef, draftData);

      writeTx.update(callbackDocRef, {
        mappingStatus: 'draft_ready',
        mappingDraftPath: `riot_match_mapping_drafts/${riotMatchId}`,
        mappingDraftId: riotMatchId,
        mappingCompletedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    });

    return {
      success: true,
      riotMatchId,
      draftPath: `riot_match_mapping_drafts/${riotMatchId}`,
    };
  } catch (err: any) {
    functions.logger.error(`Exception during createRiotMemberMappingDraftCore for callbackId: ${callbackId}`, err);
    await callbackDocRef.update({
      mappingStatus: 'mapping_failed',
      mappingErrorCode: err.message || 'unknown',
      mappingFailedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    return { success: false, errorCode: err.message || 'unknown' };
  }
}

/**
 * Cloud Function: createRiotMemberMappingDraft
 * 
 * Secure Callable trigger that creates a draft mapping 10 Riot participants to StarGroup members,
 * and proposes StarGroup A/B team mappings for Riot teams 100/200.
 */
export const createRiotMemberMappingDraft = functions
  .runWith({
    secrets: [riotApiKeySecret],
  })
  .https.onCall(async (data, context) => {
    // 1. Authenticate caller
    if (!context.auth) {
      throw new functions.https.HttpsError(
        'unauthenticated',
        'Authentication is required to create member mapping drafts.'
      );
    }

    const email = context.auth.token.email;
    if (!email) {
      throw new functions.https.HttpsError(
        'permission-denied',
        'User email is missing in the authentication token.'
      );
    }

    // 2. Authorize admin privileges
    const adminEmailDoc = await admin.firestore().collection('admin_emails').doc(email).get();
    const isAdmin = email === 'lalalalara21@gmail.com' || adminEmailDoc.exists;

    if (!isAdmin) {
      throw new functions.https.HttpsError(
        'permission-denied',
        'Only administrators are authorized to create mapping drafts.'
      );
    }

    // 3. Validate callbackId parameter
    const callbackId = data?.callbackId;
    if (!callbackId || typeof callbackId !== 'string') {
      throw new functions.https.HttpsError(
        'invalid-argument',
        'A valid callbackId string must be provided.'
      );
    }

    const result = await createRiotMemberMappingDraftCore(callbackId);
    if (!result.success) {
      throw new functions.https.HttpsError('internal', `Mapping failed: ${result.errorCode || ''}`);
    }
    return result;
  });

/**
 * Cloud Function: saveRiotMemberMappingReview
 * 
 * Secure Callable trigger that validates and saves an administrator's review
 * of a member mapping draft.
 */
export const saveRiotMemberMappingReview = functions.https.onCall(async (data: any, context: any) => {
  // 1. Authenticate caller
  if (!context.auth) {
    throw new functions.https.HttpsError(
      'unauthenticated',
      'Authentication is required to save mapping reviews.'
    );
  }

  const email = context.auth.token.email;
  const uid = context.auth.uid;
  if (!email) {
    throw new functions.https.HttpsError(
      'permission-denied',
      'User email is missing in the authentication token.'
    );
  }

  // 2. Authorize admin privileges
  const adminEmailDoc = await admin.firestore().collection('admin_emails').doc(email).get();
  const isAdmin = email === 'lalalalara21@gmail.com' || adminEmailDoc.exists;

  if (!isAdmin) {
    throw new functions.https.HttpsError(
      'permission-denied',
      'Only administrators are authorized to save mapping reviews.'
    );
  }

  // 3. Extract inputs safely (Avoid logging raw bodies containing PII)
  const riotMatchId = data?.riotMatchId;
  const saveMode = data?.saveMode || (data?.isReviewComplete ? 'complete' : 'draft');
  const participantMappings = data?.participantMappings;
  const riot100MapsTo = data?.riot100MapsTo;
  const byeolmuriMatchId = data?.byeolmuriMatchId;
  const setNumber = data?.setNumber;
  const expectedReviewRevision = typeof data?.expectedReviewRevision === 'number' ? data.expectedReviewRevision : undefined;

  if (!riotMatchId || typeof riotMatchId !== 'string') {
    throw new functions.https.HttpsError(
      'invalid-argument',
      'A valid riotMatchId string must be provided.'
    );
  }

  if (saveMode !== 'draft' && saveMode !== 'complete') {
    throw new functions.https.HttpsError(
      'invalid-argument',
      'saveMode must be either "draft" or "complete".'
    );
  }

  if (!Array.isArray(participantMappings) || participantMappings.length !== 10) {
    throw new functions.https.HttpsError(
      'invalid-argument',
      'participantMappings must be an array of exactly 10 participants.'
    );
  }

  try {
    const draftDocRef = admin.firestore().collection('riot_match_mapping_drafts').doc(riotMatchId);
    const normDocRef = admin.firestore().collection('riot_match_normalized').doc(riotMatchId);

    let reviewStatus: 'review_ready' | 'review_in_progress' = 'review_in_progress';
    let updatedFields: any = {};
    let mappedMemberIdsCount = 0;

    await admin.firestore().runTransaction(async (transaction: any) => {
      // 4. Retrieve existing Draft document inside transaction
      const draftDoc = await transaction.get(draftDocRef);
      if (!draftDoc.exists) {
        throw new functions.https.HttpsError(
          'not-found',
          `Draft document for Riot Match ID ${riotMatchId} not found.`
        );
      }

      const draftData = draftDoc.data()!;
      const oldLink = draftData.reviewedMatchLink;
      const oldStatus = draftData.reviewStatus;
      const hasOldLink = oldStatus === 'review_ready' && oldLink && oldLink.byeolmuriMatchId && oldLink.setNumber;
      
      // Concurrency Protection:
      const currentRevision = draftData.reviewRevision ?? 0;
      if (expectedReviewRevision !== undefined && expectedReviewRevision !== currentRevision) {
        throw new functions.https.HttpsError(
          'failed-precondition',
          `CONCURRENCY_ERROR: 다른 운영자가 이미 본 드래프트를 수정했습니다. 새로고침 후 다시 시도해 주세요. (현재 버전: ${currentRevision}, 요청 버전: ${expectedReviewRevision})`
        );
      }

      if (draftData.mappingStatus !== 'draft_ready') {
        throw new functions.https.HttpsError(
          'failed-precondition',
          `Draft is not in a reviewable state. Current mappingStatus: ${draftData.mappingStatus}`
        );
      }

      const currentReviewStatus = draftData.reviewStatus || 'not_started';
      const allowedReviewStatuses = ['not_started', 'review_in_progress', 'review_ready'];
      if (!allowedReviewStatuses.includes(currentReviewStatus)) {
        throw new functions.https.HttpsError(
          'failed-precondition',
          `The current reviewStatus "${currentReviewStatus}" is not valid for saving.`
        );
      }

      // 5. Retrieve normalized original match details inside transaction
      const normalizedMatchDoc = await transaction.get(normDocRef);
      if (!normalizedMatchDoc.exists) {
        throw new functions.https.HttpsError(
          'not-found',
          `Normalized match records for matchId ${riotMatchId} not found.`
        );
      }

      const normData = normalizedMatchDoc.data()!;
      const normParticipants = normData.participants || [];
      if (normParticipants.length !== 10) {
        throw new functions.https.HttpsError(
          'failed-precondition',
          'Normalized match does not have exactly 10 participants.'
        );
      }

      // 6. Validate input participantMappings
      const normParticipantIds = new Set<number>(normParticipants.map((p: any) => p.participantId));
      const inputParticipantIds = new Set<number>();
      const mappedMemberIds = new Set<string>();
      const mappingByParticipantId = new Map<number, string | null>();

      for (const mapping of participantMappings) {
        const { riotParticipantId, memberId } = mapping;
        if (typeof riotParticipantId !== 'number') {
          throw new functions.https.HttpsError(
            'invalid-argument',
            'riotParticipantId must be a valid number.'
          );
        }

        if (!normParticipantIds.has(riotParticipantId)) {
          throw new functions.https.HttpsError(
            'invalid-argument',
            `Participant ID ${riotParticipantId} does not exist in the original Riot Match.`
          );
        }

        if (inputParticipantIds.has(riotParticipantId)) {
          throw new functions.https.HttpsError(
            'invalid-argument',
            `Duplicate participantId ${riotParticipantId} found in request payload.`
          );
        }
        inputParticipantIds.add(riotParticipantId);

        if (memberId && typeof memberId === 'string' && memberId.trim() !== '') {
          const cleanMemberId = memberId.trim();
          if (mappedMemberIds.has(cleanMemberId)) {
            throw new functions.https.HttpsError(
              'failed-precondition',
              `소환사 ID ${cleanMemberId}가 여러 참가자에게 중복 배정되었습니다.`
            );
          }
          mappedMemberIds.add(cleanMemberId);
          mappingByParticipantId.set(riotParticipantId, cleanMemberId);
        } else {
          mappingByParticipantId.set(riotParticipantId, null);
        }
      }

      if (inputParticipantIds.size !== 10) {
        throw new functions.https.HttpsError(
          'invalid-argument',
          'Payload must contain mapping records for all 10 participants.'
        );
      }

      // 7. Verify all referenced members actually exist
      if (mappedMemberIds.size > 0) {
        for (const mId of mappedMemberIds) {
          const mDocRef = admin.firestore().collection('members').doc(mId);
          const mDoc = await transaction.get(mDocRef);
          if (!mDoc.exists) {
            throw new functions.https.HttpsError(
              'not-found',
              `Referenced Member ID ${mId} does not exist.`
            );
          }
        }
      }

      // Build saved reviewedParticipantMappings
      const reviewedParticipantMappings = normParticipants.map((p: any) => {
        const mId = mappingByParticipantId.get(p.participantId) || null;
        return {
          riotParticipantId: p.participantId,
          memberId: mId,
        };
      });

      // 8. Mode complete-specific validations
      if (saveMode === 'complete') {
        if (mappedMemberIds.size !== 10) {
          throw new functions.https.HttpsError(
            'failed-precondition',
            'Review cannot be completed: All 10 participants must be mapped to StarGroup members.'
          );
        }

        for (const p of normParticipants) {
          const mId = mappingByParticipantId.get(p.participantId);
          if (!mId) {
            throw new functions.https.HttpsError(
              'failed-precondition',
              `Review cannot be completed: Participant ${p.participantId} is not mapped.`
            );
          }
        }

        if (riot100MapsTo !== 'A' && riot100MapsTo !== 'B') {
          throw new functions.https.HttpsError(
            'failed-precondition',
            'Review cannot be completed: Riot Team 100 mapping to StarGroup A or B must be decided.'
          );
        }

        if (!byeolmuriMatchId || typeof byeolmuriMatchId !== 'string') {
          throw new functions.https.HttpsError(
            'failed-precondition',
            'Review cannot be completed: A valid StarGroup Match must be selected.'
          );
        }

        if (typeof setNumber !== 'number' || setNumber <= 0) {
          throw new functions.https.HttpsError(
            'failed-precondition',
            'Review cannot be completed: A valid positive Set Number must be selected.'
          );
        }

        // Fetch Byeolmuri Match
        const sgMatchDocRef = admin.firestore().collection('matches').doc(byeolmuriMatchId);
        const sgMatchDoc = await transaction.get(sgMatchDocRef);
        if (!sgMatchDoc.exists) {
          throw new functions.https.HttpsError(
            'not-found',
            `StarGroup Match ${byeolmuriMatchId} does not exist.`
          );
        }

        const sgMatchData = sgMatchDoc.data()!;
        
        // Explicit BO1/BO3 Detection:
        const totalSets = sgMatchData.totalSets;
        if (typeof totalSets !== 'number' || totalSets <= 0) {
          throw new functions.https.HttpsError(
            'failed-precondition',
            `선택한 별무리 경기(${byeolmuriMatchId})에 명시적인 경기 형식(totalSets) 정보가 설정되어 있지 않아 매핑 검토를 완료할 수 없습니다.`
          );
        }

        if (totalSets === 1 && setNumber !== 1) {
          throw new functions.https.HttpsError(
            'failed-precondition',
            `Selected StarGroup Match is BO1, which only allows Set 1. (Selected: Set ${setNumber})`
          );
        }

        if (setNumber > totalSets) {
          throw new functions.https.HttpsError(
            'failed-precondition',
            `Selected Set Number (${setNumber}) exceeds total sets (${totalSets}) of the selected StarGroup Match.`
          );
        }

        if (setNumber > 3) {
          throw new functions.https.HttpsError(
            'failed-precondition',
            `Selected Set Number (${setNumber}) exceeds maximum allowed sets (3).`
          );
        }

        // Double linking check using reservation lock document (prevents concurrent write skew)
        const reservationId = `${byeolmuriMatchId}_${setNumber}`;
        const reservationDocRef = admin.firestore().collection('riot_set_link_reservations').doc(reservationId);
        const reservationDoc = await transaction.get(reservationDocRef);

        if (reservationDoc.exists) {
          const reservationData = reservationDoc.data()!;
          if (reservationData.riotMatchId !== riotMatchId) {
            throw new functions.https.HttpsError(
              'failed-precondition',
              `선택하신 별무리 세트(경기: ${byeolmuriMatchId}, 세트: ${setNumber})는 이미 다른 Riot 매치 검토(${reservationData.riotMatchId})에서 사용되었습니다. 세트 중복 연결은 금지되어 있습니다.`
            );
          }
        } else {
          transaction.set(reservationDocRef, {
            byeolmuriMatchId,
            setNumber,
            riotMatchId,
            draftPath: `riot_match_mapping_drafts/${riotMatchId}`,
            reservedAt: admin.firestore.FieldValue.serverTimestamp(),
          });
        }

        // Release old reservation if it was linked to a different match/set
        if (hasOldLink && (oldLink.byeolmuriMatchId !== byeolmuriMatchId || oldLink.setNumber !== setNumber)) {
          const oldResId = `${oldLink.byeolmuriMatchId}_${oldLink.setNumber}`;
          const oldResRef = admin.firestore().collection('riot_set_link_reservations').doc(oldResId);
          transaction.delete(oldResRef);
        }

        // Team assignment check (5 vs 5)
        const membersInA: string[] = [];
        const membersInB: string[] = [];
        const team100Target = riot100MapsTo;
        const team200Target = team100Target === 'A' ? 'B' : 'A';

        for (const p of normParticipants) {
          const mId = mappingByParticipantId.get(p.participantId)!;
          const originalTeamId = p.teamId; // 100 or 200
          if (originalTeamId === 100) {
            if (team100Target === 'A') membersInA.push(mId);
            else membersInB.push(mId);
          } else if (originalTeamId === 200) {
            if (team200Target === 'A') membersInA.push(mId);
            else membersInB.push(mId);
          } else {
            throw new functions.https.HttpsError(
              'failed-precondition',
              `Participant ${p.participantId} has invalid teamId: ${originalTeamId}. Must be 100 or 200.`
            );
          }
        }

        if (membersInA.length !== 5 || membersInB.length !== 5) {
          throw new functions.https.HttpsError(
            'failed-precondition',
            `팀 매핑 정합성 오류: 별무리 A팀에 ${membersInA.length}명, B팀에 ${membersInB.length}명이 배치되었습니다. 양 팀은 반드시 5명씩이어야 합니다.`
          );
        }

        reviewStatus = 'review_ready';
      } else {
        reviewStatus = 'review_in_progress';

        // Release old reservation lock if it existed, since the draft is no longer in complete/review_ready status
        if (hasOldLink) {
          const oldResId = `${oldLink.byeolmuriMatchId}_${oldLink.setNumber}`;
          const oldResRef = admin.firestore().collection('riot_set_link_reservations').doc(oldResId);
          transaction.delete(oldResRef);
        }
      }

      // Build updated fields
      updatedFields = {
        reviewStatus,
        reviewedParticipantMappings,
        reviewedTeamMapping: {
          riotTeam100: riot100MapsTo || null,
          riotTeam200: riot100MapsTo ? (riot100MapsTo === 'A' ? 'B' : 'A') : null,
        },
        reviewedMatchLink: (byeolmuriMatchId && setNumber) ? {
          byeolmuriMatchId,
          setNumber,
        } : null,
        reviewedByUid: uid,
        reviewedByEmail: email,
        reviewSavedAt: admin.firestore.FieldValue.serverTimestamp(),
        reviewErrorCode: null,
        reviewSchemaVersion: 1,
        reviewRevision: currentRevision + 1, // Atomic revision increment
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      };

      if (!draftData.reviewStartedAt) {
        updatedFields.reviewStartedAt = admin.firestore.FieldValue.serverTimestamp();
      }

      mappedMemberIdsCount = mappedMemberIds.size;

      transaction.update(draftDocRef, updatedFields);
    });

    functions.logger.info(`Mapping review saved successfully.`, {
      riotMatchId,
      reviewStatus,
      mappedParticipantsCount: mappedMemberIdsCount,
      callerUid: uid,
      saveMode,
    });

    return {
      success: true,
      riotMatchId,
      reviewStatus,
    };
  } catch (err: any) {
    if (err instanceof functions.https.HttpsError) {
      functions.logger.warn(`Mapping review validation failed for riotMatchId: ${riotMatchId}`, {
        message: err.message,
        code: err.code,
        callerUid: uid,
      });
      throw err;
    }

    functions.logger.error(`Unhandled error during mapping review save for riotMatchId: ${riotMatchId}`, {
      message: err.message || String(err),
      callerUid: uid,
    });

    throw new functions.https.HttpsError(
      'internal',
      `An internal error occurred while saving the review: ${err.message || ''}`
    );
  }
});
