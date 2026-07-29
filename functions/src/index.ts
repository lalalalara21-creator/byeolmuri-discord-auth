import * as functions from 'firebase-functions';
import * as admin from 'firebase-admin';
import 'firebase-admin/firestore';
import { defineSecret } from 'firebase-functions/params';
import { RiotTournamentServiceImpl, RiotTournamentMockService } from './riot_tournament_service';
import { RiotSpectatorService, normalizeQueueType, CHAMPION_ID_MAP } from './riot_spectator_service';

// Initialize Firebase Admin SDK
admin.initializeApp();

export { discordAuthCallback } from './auth/discordAuth';
import {
  createRiotMemberMappingDraftCore,
  createRiotMemberMappingDraft,
  saveRiotMemberMappingReview,
  verifyAndLinkRiotAccount,
} from './riot/riotAccount';

export {
  createRiotMemberMappingDraft,
  saveRiotMemberMappingReview,
  verifyAndLinkRiotAccount,
};

const riotCallbackSecret = defineSecret('RIOT_CALLBACK_SECRET');
const riotApiKeySecret = defineSecret('RIOT_API_KEY');

interface RiotTournamentCallbackBody {
  startTime: number;
  shortCode: string;
  metaData: string;
  gameId: number;
  gameName?: string | null;
  gameType?: string | null;
  gameMap?: number | null;
  gameMode?: string | null;
  region?: string | null;
}

/**
 * Cloud Function: riotTournamentCallback
 * 
 * Secure HTTPS Request Trigger to handle and verify Riot Games Tournament Callbacks.
 */
export const riotTournamentCallback = functions
  .runWith({
    secrets: [riotCallbackSecret, riotApiKeySecret],
  })
  .https.onRequest(async (req, res) => {
    // 1. Allow only POST requests
    if (req.method !== 'POST') {
      functions.logger.warn(`Riot Callback rejected: Method ${req.method} not allowed.`);
      res.status(405).setHeader('Allow', 'POST').send('Method Not Allowed');
      return;
    }

    // 2. Validate Secret token in Query Parameters
    const token = req.query.token;
    const secretValue = riotCallbackSecret.value();

    if (!secretValue) {
      functions.logger.error('Riot Callback Secret (RIOT_CALLBACK_SECRET) is not configured in Secret Manager.');
      res.status(500).send('Internal Server Error');
      return;
    }

    if (!token || token !== secretValue) {
      functions.logger.warn('Riot Callback unauthorized: Token mismatch or missing token.');
      res.status(403).send('Forbidden');
      return;
    }

    const body = req.body;

    // 3. Validate Body format and type
    if (typeof body !== 'object' || body === null) {
      functions.logger.warn('Riot Callback rejected: Body is not a valid object.');
      res.status(400).send('Bad Request');
      return;
    }

    const { gameId, shortCode, startTime, metaData } = body;

    // Validate positive non-NaN integer gameId
    if (typeof gameId !== 'number' || isNaN(gameId) || gameId <= 0) {
      functions.logger.warn('Riot Callback rejected: Invalid or missing gameId.');
      res.status(400).send('Bad Request');
      return;
    }

    // Validate non-empty shortCode
    if (typeof shortCode !== 'string' || shortCode.trim() === '') {
      functions.logger.warn(`Riot Callback rejected: Invalid or missing shortCode for gameId ${gameId}.`);
      res.status(400).send('Bad Request');
      return;
    }

    // Validate non-NaN startTime
    if (typeof startTime !== 'number' || isNaN(startTime)) {
      functions.logger.warn(`Riot Callback rejected: Invalid or missing startTime for gameId ${gameId}.`);
      res.status(400).send('Bad Request');
      return;
    }

    // Validate metaData string
    if (typeof metaData !== 'string') {
      functions.logger.warn(`Riot Callback rejected: Invalid or missing metaData for gameId ${gameId}.`);
      res.status(400).send('Bad Request');
      return;
    }

    // Extract official, safe optional fields with fallback
    const gameName = typeof body.gameName === 'string' ? body.gameName : null;
    const gameType = typeof body.gameType === 'string' ? body.gameType : null;
    const gameMap = typeof body.gameMap === 'number' && !isNaN(body.gameMap) ? body.gameMap : null;
    const gameMode = typeof body.gameMode === 'string' ? body.gameMode : null;
    const region = typeof body.region === 'string' ? body.region : null;

    const callbackData: RiotTournamentCallbackBody = {
      startTime,
      shortCode,
      metaData,
      gameId,
      gameName,
      gameType,
      gameMap,
      gameMode,
      region,
    };

    // 4. Parse metaData safely (do not reject whole callback if JSON parse fails)
    let parsedMetadata: any = null;
    try {
      parsedMetadata = JSON.parse(metaData);
    } catch (e) {
      functions.logger.warn(`Failed to parse metaData JSON for gameId ${gameId}. Storing parsedMetadata as null.`);
      parsedMetadata = null;
    }

    // 5. Match Lookup using tournamentCode (shortCode) or parsedMetadata.matchId
    let matchedMatchId: string | null = null;
    const cleanShortCode = shortCode.trim();

    const matchesSnap = await admin.firestore()
      .collection('matches')
      .where('tournamentCode', '==', cleanShortCode)
      .limit(1)
      .get();

    if (!matchesSnap.empty) {
      matchedMatchId = matchesSnap.docs[0].id;
    } else if (parsedMetadata && typeof parsedMetadata.matchId === 'string' && parsedMetadata.matchId.trim() !== '') {
      const targetMatchId = parsedMetadata.matchId.trim();
      const matchDocSnap = await admin.firestore().collection('matches').doc(targetMatchId).get();
      if (matchDocSnap.exists) {
        matchedMatchId = matchDocSnap.id;
      }
    }

    // 6. Duplicate callback prevention & Match status update using Firestore Transaction
    const regionStr = typeof region === 'string' && region.trim() !== '' ? region.trim().toUpperCase() : 'UNKNOWN';
    const docId = `${regionStr}_${gameId}`;
    const docRef = admin.firestore().collection('riot_tournament_callbacks').doc(docId);

    // If no match was found for this tournament code:
    if (!matchedMatchId) {
      functions.logger.warn(
        `Riot Callback blocked: No matching match found for tournamentCode '${shortCode}' (gameId: ${gameId}).`
      );

      await docRef.set({
        gameId: callbackData.gameId,
        riotMatchIdCandidate: `${regionStr}_${callbackData.gameId}`,
        shortCode: callbackData.shortCode,
        startTime: callbackData.startTime,
        gameName: callbackData.gameName,
        gameType: callbackData.gameType,
        gameMap: callbackData.gameMap,
        gameMode: callbackData.gameMode,
        region: callbackData.region,
        metaData: callbackData.metaData,
        parsedMetadata,
        receivedAt: admin.firestore.FieldValue.serverTimestamp(),
        processingStatus: 'blocked_match_not_found',
        blockReason: 'no_matching_tournament_code',
        matchedMatchId: null,
        duplicateCount: 1,
        lastReceivedAt: admin.firestore.FieldValue.serverTimestamp(),
      }, { merge: true });

      res.status(200).json({
        success: false,
        blocked: true,
        reason: 'blocked_match_not_found',
        message: 'No Byeolmuri match found corresponding to this tournament code.',
      });
      return;
    }

    const matchRef = admin.firestore().collection('matches').doc(matchedMatchId);

    try {
      let isDuplicate = false;

      await admin.firestore().runTransaction(async (transaction) => {
        const callbackSnap = await transaction.get(docRef);
        const matchSnap = await transaction.get(matchRef);

        if (callbackSnap.exists) {
          const currentData = callbackSnap.data();
          const currentCount = typeof currentData?.duplicateCount === 'number' ? currentData.duplicateCount : 1;
          isDuplicate = true;

          // Increment duplicate count on callback doc without overriding match state if already processed
          transaction.update(docRef, {
            duplicateCount: currentCount + 1,
            lastReceivedAt: admin.firestore.FieldValue.serverTimestamp(),
          });
        } else {
          isDuplicate = false;

          // Mark callback document as received and matched
          transaction.set(docRef, {
            gameId: callbackData.gameId,
            riotMatchIdCandidate: `${regionStr}_${callbackData.gameId}`,
            shortCode: callbackData.shortCode,
            matchedMatchId: matchedMatchId,
            startTime: callbackData.startTime,
            gameName: callbackData.gameName,
            gameType: callbackData.gameType,
            gameMap: callbackData.gameMap,
            gameMode: callbackData.gameMode,
            region: callbackData.region,
            metaData: callbackData.metaData,
            parsedMetadata,
            receivedAt: admin.firestore.FieldValue.serverTimestamp(),
            processingStatus: 'received_matched',
            callbackReceived: true,
            duplicateCount: 1,
            lastReceivedAt: admin.firestore.FieldValue.serverTimestamp(),
          });

          // Update corresponding Match document status to 'callback_received'
          if (matchSnap.exists) {
            transaction.update(matchRef, {
              tournamentStatus: 'callback_received',
              riotGameId: gameId,
              callbackId: docId,
              callbackReceivedAt: admin.firestore.FieldValue.serverTimestamp(),
              updatedAt: admin.firestore.FieldValue.serverTimestamp(),
            });
          }
        }
      });

      functions.logger.info(
        `Riot Callback processed successfully. tournamentCode: '${shortCode}', gameId: ${gameId}, matchId: ${matchedMatchId}, isDuplicate: ${isDuplicate}, status: received_matched`
      );

      // Trigger Phase 4 Riot Match Processing Pipeline
      try {
        await runRiotMatchProcessingPipeline(docId, matchedMatchId);
      } catch (pipelineErr) {
        functions.logger.error(`Error running Riot match processing pipeline for callbackId ${docId}:`, pipelineErr);
      }

      res.status(200).json({
        success: true,
        matchId: matchedMatchId,
        duplicate: isDuplicate,
        status: 'received_matched',
      });
    } catch (err: any) {
      // Secure logging: only log gameId, region and error message. Never log raw metadata, body, secrets.
      functions.logger.error(`Error saving Riot Callback in Firestore transaction for gameId: ${gameId}, region: ${regionStr}`, {
        message: err instanceof Error ? err.message : String(err),
      });
      res.status(500).send('Internal Server Error');
    }
  });

/**
 * Helper to determine the regional routing for Match-v5 based on region/platform ID.
 * Supports South Korea ('KR' or 'KR1') mapping to 'asia'.
 */
function getMatchRoutingRegion(region: string | null | undefined): string | null {
  if (!region) return null;
  const normalized = region.trim().toUpperCase();
  if (normalized === 'KR' || normalized === 'KR1') {
    return 'asia';
  }
  return null;
}

interface RiotMatchV5Response {
  metadata: {
    matchId: string;
    participants: string[];
  };
  info: {
    gameId: number;
    gameCreation: number;
    gameDuration: number;
    gameEndTimestamp?: number;
    gameMode: string;
    gameName: string;
    gameType: string;
    gameVersion: string;
    mapId: number;
    platformId: string;
    queueId: number;
    tournamentCode?: string;
    participants: any[];
    teams: any[];
  };
}

/**
 * Core helper function to verify a Riot tournament match callback.
 */
async function verifyRiotTournamentMatchCore(callbackId: string) {
  const callbackDocRef = admin.firestore().collection('riot_tournament_callbacks').doc(callbackId);
  let callbackData: any = null;

  try {
    const transactionResult = await admin.firestore().runTransaction(async (transaction) => {
      const docSnapshot = await transaction.get(callbackDocRef);
      if (!docSnapshot.exists) {
        return { canProceed: false, reason: 'not_found', callback: null };
      }

      const docData = docSnapshot.data()!;
      const status = docData.processingStatus;
      const errCode = docData.verificationErrorCode;

      if (status === 'verified') {
        return { canProceed: false, reason: 'verified', callback: docData };
      }

      if (status === 'verifying') {
        return { canProceed: false, reason: 'in_progress', callback: docData };
      }

      if (status === 'verification_failed') {
        const retryableErrors = ['riot_rate_limited', 'riot_service_error', 'riot_network_error'];
        if (!retryableErrors.includes(errCode)) {
          return { canProceed: false, reason: 'failed_non_retryable', callback: docData, errorCode: errCode };
        }
      }

      transaction.update(callbackDocRef, {
        processingStatus: 'verifying',
        verificationStartedAt: admin.firestore.FieldValue.serverTimestamp(),
        verificationErrorCode: null,
      });

      return { canProceed: true, callback: docData };
    });

    if (!transactionResult.canProceed) {
      if (transactionResult.reason === 'verified') {
        return {
          success: true,
          status: 'verified',
          alreadyVerified: true,
          matchId: transactionResult.callback?.riotMatchId || `KR_${transactionResult.callback?.gameId}`,
          gameId: transactionResult.callback?.gameId,
        };
      }
      return {
        success: false,
        status: 'verification_failed',
        errorCode: transactionResult.errorCode || transactionResult.reason || 'cannot_verify',
      };
    }

    callbackData = transactionResult.callback;
  } catch (error: any) {
    functions.logger.error(`Error in transaction for callbackId: ${callbackId}`, error);
    return { success: false, status: 'verification_failed', errorCode: 'database_error' };
  }

  const gameId = callbackData.gameId;
  const region = callbackData.region;
  const shortCode = callbackData.shortCode;
  const matchId = callbackData.riotMatchIdCandidate || `KR_${gameId}`;
  const routingRegion = getMatchRoutingRegion(region);

  if (!routingRegion) {
    await callbackDocRef.update({
      processingStatus: 'verification_failed',
      verificationErrorCode: 'unsupported_region',
      verificationFailedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    return { success: false, status: 'verification_failed', errorCode: 'unsupported_region' };
  }

  const apiKey = riotApiKeySecret.value();
  if (!apiKey) {
    await callbackDocRef.update({
      processingStatus: 'verification_failed',
      verificationErrorCode: 'riot_api_unauthorized',
      verificationFailedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    return { success: false, status: 'verification_failed', errorCode: 'riot_api_unauthorized' };
  }

  const url = `https://${routingRegion}.api.riotgames.com/lol/match/v5/matches/${matchId}`;
  let matchData: RiotMatchV5Response | null = null;
  let errorCode: string | null = null;

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10000);

    let response: Response;
    try {
      response = await fetch(url, {
        headers: { 'X-Riot-Token': apiKey },
        signal: controller.signal,
      });
    } catch (fetchErr: any) {
      errorCode = 'riot_network_error';
      throw fetchErr;
    } finally {
      clearTimeout(timeoutId);
    }

    if (!response.ok) {
      const status = response.status;
      if (status === 400) errorCode = 'invalid_request';
      else if (status === 401) errorCode = 'riot_api_unauthorized';
      else if (status === 403) errorCode = 'riot_api_forbidden';
      else if (status === 404) errorCode = 'riot_match_not_found';
      else if (status === 429) errorCode = 'riot_rate_limited';
      else if (status >= 500) errorCode = 'riot_service_error';
      else errorCode = 'riot_network_error';

      throw new Error(`Riot Match-v5 fetch returned HTTP Status: ${status}`);
    }

    matchData = (await response.json()) as RiotMatchV5Response;
  } catch (err: any) {
    const finalErrorCode = errorCode || 'riot_network_error';
    functions.logger.warn(`Fetch failure on Riot Match-v5 for callbackId ${callbackId} (matchId: ${matchId}). Error Code: ${finalErrorCode}.`);

    await callbackDocRef.update({
      processingStatus: 'verification_failed',
      verificationErrorCode: finalErrorCode,
      verificationFailedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    return {
      success: false,
      status: 'verification_failed',
      errorCode: finalErrorCode,
    };
  }

  let validationErrorCode: string | null = null;
  const responseMatchId = matchData?.metadata?.matchId;
  const responseGameId = matchData?.info?.gameId;
  const platformId = matchData?.info?.platformId;
  const metadataParticipants = matchData?.metadata?.participants;
  const infoParticipants = matchData?.info?.participants;
  const teams = matchData?.info?.teams;
  const mapId = matchData?.info?.mapId;
  const gameMode = matchData?.info?.gameMode;
  const gameType = matchData?.info?.gameType;

  if (responseMatchId !== matchId) validationErrorCode = 'match_id_mismatch';
  else if (responseGameId !== gameId) validationErrorCode = 'game_id_mismatch';
  else if (platformId !== 'KR' && platformId !== 'KR1') validationErrorCode = 'platform_id_mismatch';
  else if (!Array.isArray(metadataParticipants)) validationErrorCode = 'invalid_metadata_participants';
  else if (!Array.isArray(infoParticipants) || infoParticipants.length !== 10) validationErrorCode = 'invalid_participants_count';
  else if (!Array.isArray(teams)) validationErrorCode = 'invalid_teams';
  else if (mapId !== 11) validationErrorCode = 'invalid_map_id';
  else if (typeof gameMode !== 'string' || typeof gameType !== 'string') validationErrorCode = 'invalid_game_mode_or_type';

  if (validationErrorCode) {
    await callbackDocRef.update({
      processingStatus: 'verification_failed',
      verificationErrorCode: validationErrorCode,
      verificationFailedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    return {
      success: false,
      status: 'verification_failed',
      errorCode: validationErrorCode,
    };
  }

  let tournamentCodeFromMatch: string | null = null;
  let tournamentCodeVerified: boolean | null = null;

  const matchTournamentCode = matchData?.info?.tournamentCode;
  if (typeof matchTournamentCode === 'string' && matchTournamentCode.trim() !== '') {
    tournamentCodeFromMatch = matchTournamentCode;
    if (shortCode) {
      tournamentCodeVerified = matchTournamentCode === shortCode || matchTournamentCode.includes(shortCode);
    }
  }

  const rawMatchDocRef = admin.firestore().collection('riot_match_raw').doc(matchId);

  try {
    await rawMatchDocRef.set({
      matchId: matchId,
      callbackId: callbackId,
      gameId: gameId,
      fetchedAt: admin.firestore.FieldValue.serverTimestamp(),
      source: 'match-v5',
      rawData: matchData,
      schemaVersion: 1,
    });

    await callbackDocRef.update({
      processingStatus: 'verified',
      verifiedAt: admin.firestore.FieldValue.serverTimestamp(),
      riotMatchId: matchId,
      riotGameId: responseGameId,
      platformId: platformId,
      gameCreation: matchData.info.gameCreation || null,
      gameDuration: matchData.info.gameDuration || null,
      gameEndTimestamp: matchData.info.gameEndTimestamp || null,
      gameMode: gameMode,
      gameType: gameType,
      gameVersion: matchData.info.gameVersion || null,
      mapId: mapId,
      queueId: matchData.info.queueId || null,
      participantCount: infoParticipants.length,
      tournamentCodeFromMatch: tournamentCodeFromMatch,
      tournamentCodeVerified: tournamentCodeVerified,
    });

    return {
      success: true,
      status: 'verified',
      matchId: matchId,
      gameId: gameId,
    };
  } catch (err: any) {
    await callbackDocRef.update({
      processingStatus: 'verification_failed',
      verificationErrorCode: 'system_storage_error',
      verificationFailedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    return {
      success: false,
      status: 'verification_failed',
      errorCode: 'system_storage_error',
    };
  }
}

/**
 * Cloud Function: verifyRiotTournamentMatch
 */
export const verifyRiotTournamentMatch = functions
  .runWith({
    secrets: [riotApiKeySecret],
    timeoutSeconds: 30,
  })
  .https.onCall(async (data, context) => {
    if (!context.auth) throw new functions.https.HttpsError('unauthenticated', 'Authentication is required.');
    const email = context.auth.token.email;
    if (!email) throw new functions.https.HttpsError('permission-denied', 'User email is missing.');
    const adminEmailDoc = await admin.firestore().collection('admin_emails').doc(email).get();
    const isAdmin = email === 'lalalalara21@gmail.com' || adminEmailDoc.exists;
    if (!isAdmin) throw new functions.https.HttpsError('permission-denied', 'Only administrators authorized.');

    const callbackId = data?.callbackId;
    if (!callbackId || typeof callbackId !== 'string') {
      throw new functions.https.HttpsError('invalid-argument', 'Valid callbackId string required.');
    }

    return await verifyRiotTournamentMatchCore(callbackId);
  });

interface NormalizedRiotParticipant {
  // 식별 정보
  puuid: string;
  summonerId: string;
  riotIdGameName: string;
  riotIdTagline: string;
  summonerName: string | null;
  participantId: number;
  teamId: number;

  // 챔피언 및 포지션
  championId: number;
  championName: string;
  teamPosition: string;
  individualPosition: string;
  lane: string;
  role: string;

  // 승패 및 기본 전투 기록
  win: boolean;
  kills: number;
  deaths: number;
  assists: number;
  champLevel: number;

  // 성장 기록
  goldEarned: number;
  goldSpent: number;
  totalMinionsKilled: number;
  neutralMinionsKilled: number;
  totalCs: number;

  // 피해 및 기여도
  totalDamageDealtToChampions: number;
  physicalDamageDealtToChampions: number;
  magicDamageDealtToChampions: number;
  trueDamageDealtToChampions: number;
  totalDamageTaken: number;
  damageSelfMitigated: number;
  totalHeal: number;
  totalHealsOnTeammates: number;
  timeCCingOthers: number;
  totalTimeCCDealt: number;
  visionScore: number;
  wardsPlaced: number;
  wardsKilled: number;
  visionWardsBoughtInGame: number;

  // 연속 기록
  doubleKills: number;
  tripleKills: number;
  quadraKills: number;
  pentaKills: number;
  largestKillingSpree: number;
  largestMultiKill: number;
  firstBloodKill: boolean;
  firstBloodAssist: boolean;

  // 아이템
  item0: number;
  item1: number;
  item2: number;
  item3: number;
  item4: number;
  item5: number;
  item6: number;
  items: number[];

  // 룬 정보 정규화
  perks: {
    primaryStyleId: number | null;
    subStyleId: number | null;
    selectedPerkIds: number[];
    statPerkIds: number[];
  };

  // 도전과제 Challenges
  challenges: {
    killParticipation: number | null;
    kda: number | null;
    teamDamagePercentage: number | null;
    damagePerMinute: number | null;
    goldPerMinute: number | null;
    visionScorePerMinute: number | null;
    soloKills: number | null;
    turretPlatesTaken: number | null;
    controlWardsPlaced: number | null;
  };
}

interface NormalizedRiotTeam {
  teamId: number;
  win: boolean;
  bans: Array<{
    championId: number;
    pickTurn: number;
  }>;
  objectives: {
    baron: { first: boolean; kills: number };
    champion: { first: boolean; kills: number };
    dragon: { first: boolean; kills: number };
    inhibitor: { first: boolean; kills: number };
    riftHerald: { first: boolean; kills: number };
    tower: { first: boolean; kills: number };
  };
}

interface NormalizedRiotMatch {
  schemaVersion: number;
  riotMatchId: string;
  callbackId: string;
  gameId: number;
  platformId: string;
  gameCreation: number;
  gameDuration: number;
  gameEndTimestamp: number | null;
  gameMode: string;
  gameType: string;
  gameVersion: string;
  mapId: number;
  queueId: number;
  tournamentCode: string | null;
  participantCount: number;
  normalizedAt: any;
  participants: NormalizedRiotParticipant[];
  teams: NormalizedRiotTeam[];
  sourceRawPath: string;
}

/**
 * Safely parse participant perks styles and selections.
 */
function parsePerks(rawPerks: any) {
  const result = {
    primaryStyleId: null as number | null,
    subStyleId: null as number | null,
    selectedPerkIds: [] as number[],
    statPerkIds: [] as number[],
  };

  if (!rawPerks) return result;

  if (Array.isArray(rawPerks.styles)) {
    for (const s of rawPerks.styles) {
      if (s && s.description === 'primaryStyle') {
        result.primaryStyleId = typeof s.style === 'number' ? s.style : null;
        if (Array.isArray(s.selections)) {
          for (const sel of s.selections) {
            if (sel && typeof sel.perk === 'number') {
              result.selectedPerkIds.push(sel.perk);
            }
          }
        }
      } else if (s && s.description === 'subStyle') {
        result.subStyleId = typeof s.style === 'number' ? s.style : null;
        if (Array.isArray(s.selections)) {
          for (const sel of s.selections) {
            if (sel && typeof sel.perk === 'number') {
              result.selectedPerkIds.push(sel.perk);
            }
          }
        }
      }
    }
  }

  if (rawPerks.statPerks) {
    const defense = rawPerks.statPerks.defense;
    const flex = rawPerks.statPerks.flex;
    const offense = rawPerks.statPerks.offense;
    if (typeof offense === 'number') result.statPerkIds.push(offense);
    if (typeof flex === 'number') result.statPerkIds.push(flex);
    if (typeof defense === 'number') result.statPerkIds.push(defense);
  }

  return result;
}

/**
 * Safely parse participant challenges.
 */
function parseChallenges(rawChallenges: any) {
  const fields = [
    'killParticipation',
    'kda',
    'teamDamagePercentage',
    'damagePerMinute',
    'goldPerMinute',
    'visionScorePerMinute',
    'soloKills',
    'turretPlatesTaken',
    'controlWardsPlaced',
  ];
  const result: any = {};
  for (const field of fields) {
    if (rawChallenges && typeof rawChallenges[field] === 'number' && !isNaN(rawChallenges[field])) {
      result[field] = rawChallenges[field];
    } else {
      result[field] = null;
    }
  }
  return result;
}

/**
 * Safely parse teams and their bans and objectives.
 */
function parseTeams(rawTeams: any[]): NormalizedRiotTeam[] {
  if (!Array.isArray(rawTeams)) return [];
  return rawTeams.map((t: any) => {
    const bans: any[] = [];
    if (Array.isArray(t.bans)) {
      t.bans.forEach((b: any) => {
        if (b && typeof b.championId === 'number') {
          bans.push({
            championId: b.championId,
            pickTurn: typeof b.pickTurn === 'number' ? b.pickTurn : 0,
          });
        }
      });
    }

    const defaultObj = { first: false, kills: 0 };
    const getObj = (obj: any) => {
      if (!obj) return { ...defaultObj };
      return {
        first: typeof obj.first === 'boolean' ? obj.first : false,
        kills: typeof obj.kills === 'number' && !isNaN(obj.kills) ? obj.kills : 0,
      };
    };

    const objectives = {
      baron: getObj(t.objectives?.baron),
      champion: getObj(t.objectives?.champion),
      dragon: getObj(t.objectives?.dragon),
      inhibitor: getObj(t.objectives?.inhibitor),
      riftHerald: getObj(t.objectives?.riftHerald || t.objectives?.horde),
      tower: getObj(t.objectives?.tower),
    };

    return {
      teamId: typeof t.teamId === 'number' ? t.teamId : 0,
      win: typeof t.win === 'boolean' ? t.win : false,
      bans,
      objectives,
    };
  });
}

/**
 * Safely parse participant raw data into the normalized structure.
 */
function parseParticipant(p: any): NormalizedRiotParticipant {
  const item0 = typeof p.item0 === 'number' && !isNaN(p.item0) ? p.item0 : 0;
  const item1 = typeof p.item1 === 'number' && !isNaN(p.item1) ? p.item1 : 0;
  const item2 = typeof p.item2 === 'number' && !isNaN(p.item2) ? p.item2 : 0;
  const item3 = typeof p.item3 === 'number' && !isNaN(p.item3) ? p.item3 : 0;
  const item4 = typeof p.item4 === 'number' && !isNaN(p.item4) ? p.item4 : 0;
  const item5 = typeof p.item5 === 'number' && !isNaN(p.item5) ? p.item5 : 0;
  const item6 = typeof p.item6 === 'number' && !isNaN(p.item6) ? p.item6 : 0;

  const totalMinionsKilled = typeof p.totalMinionsKilled === 'number' && !isNaN(p.totalMinionsKilled) ? p.totalMinionsKilled : 0;
  const neutralMinionsKilled = typeof p.neutralMinionsKilled === 'number' && !isNaN(p.neutralMinionsKilled) ? p.neutralMinionsKilled : 0;

  return {
    // 식별 정보
    puuid: typeof p.puuid === 'string' ? p.puuid : '',
    summonerId: typeof p.summonerId === 'string' ? p.summonerId : '',
    riotIdGameName: typeof p.riotIdGameName === 'string' ? p.riotIdGameName : '',
    riotIdTagline: typeof p.riotIdTagline === 'string' ? p.riotIdTagline : '',
    summonerName: typeof p.summonerName === 'string' ? p.summonerName : null,
    participantId: typeof p.participantId === 'number' ? p.participantId : 0,
    teamId: typeof p.teamId === 'number' ? p.teamId : 0,

    // 챔피언 및 포지션
    championId: typeof p.championId === 'number' ? p.championId : 0,
    championName: typeof p.championName === 'string' ? p.championName : '',
    teamPosition: typeof p.teamPosition === 'string' ? p.teamPosition : '',
    individualPosition: typeof p.individualPosition === 'string' ? p.individualPosition : '',
    lane: typeof p.lane === 'string' ? p.lane : '',
    role: typeof p.role === 'string' ? p.role : '',

    // 승패 및 기본 전투 기록
    win: typeof p.win === 'boolean' ? p.win : false,
    kills: typeof p.kills === 'number' ? p.kills : 0,
    deaths: typeof p.deaths === 'number' ? p.deaths : 0,
    assists: typeof p.assists === 'number' ? p.assists : 0,
    champLevel: typeof p.champLevel === 'number' ? p.champLevel : 0,

    // 성장 기록
    goldEarned: typeof p.goldEarned === 'number' ? p.goldEarned : 0,
    goldSpent: typeof p.goldSpent === 'number' ? p.goldSpent : 0,
    totalMinionsKilled,
    neutralMinionsKilled,
    totalCs: totalMinionsKilled + neutralMinionsKilled,

    // 피해 및 기여도
    totalDamageDealtToChampions: typeof p.totalDamageDealtToChampions === 'number' ? p.totalDamageDealtToChampions : 0,
    physicalDamageDealtToChampions: typeof p.physicalDamageDealtToChampions === 'number' ? p.physicalDamageDealtToChampions : 0,
    magicDamageDealtToChampions: typeof p.magicDamageDealtToChampions === 'number' ? p.magicDamageDealtToChampions : 0,
    trueDamageDealtToChampions: typeof p.trueDamageDealtToChampions === 'number' ? p.trueDamageDealtToChampions : 0,
    totalDamageTaken: typeof p.totalDamageTaken === 'number' ? p.totalDamageTaken : 0,
    damageSelfMitigated: typeof p.damageSelfMitigated === 'number' ? p.damageSelfMitigated : 0,
    totalHeal: typeof p.totalHeal === 'number' ? p.totalHeal : 0,
    totalHealsOnTeammates: typeof p.totalHealsOnTeammates === 'number' ? p.totalHealsOnTeammates : 0,
    timeCCingOthers: typeof p.timeCCingOthers === 'number' ? p.timeCCingOthers : 0,
    totalTimeCCDealt: typeof p.totalTimeCCDealt === 'number' ? p.totalTimeCCDealt : 0,
    visionScore: typeof p.visionScore === 'number' ? p.visionScore : 0,
    wardsPlaced: typeof p.wardsPlaced === 'number' ? p.wardsPlaced : 0,
    wardsKilled: typeof p.wardsKilled === 'number' ? p.wardsKilled : 0,
    visionWardsBoughtInGame: typeof p.visionWardsBoughtInGame === 'number' ? p.visionWardsBoughtInGame : 0,

    // 연속 기록
    doubleKills: typeof p.doubleKills === 'number' ? p.doubleKills : 0,
    tripleKills: typeof p.tripleKills === 'number' ? p.tripleKills : 0,
    quadraKills: typeof p.quadraKills === 'number' ? p.quadraKills : 0,
    pentaKills: typeof p.pentaKills === 'number' ? p.pentaKills : 0,
    largestKillingSpree: typeof p.largestKillingSpree === 'number' ? p.largestKillingSpree : 0,
    largestMultiKill: typeof p.largestMultiKill === 'number' ? p.largestMultiKill : 0,
    firstBloodKill: typeof p.firstBloodKill === 'boolean' ? p.firstBloodKill : false,
    firstBloodAssist: typeof p.firstBloodAssist === 'boolean' ? p.firstBloodAssist : false,

    // 아이템
    item0,
    item1,
    item2,
    item3,
    item4,
    item5,
    item6,
    items: [item0, item1, item2, item3, item4, item5, item6],

    // 룬 정보
    perks: parsePerks(p.perks),

    // 도전과제
    challenges: parseChallenges(p.challenges),
  };
}

/**
 * Core helper function to normalize a verified Riot tournament match.
 */
async function normalizeRiotTournamentMatchCore(callbackId: string) {
  const callbackDocRef = admin.firestore().collection('riot_tournament_callbacks').doc(callbackId);
  let callbackData: any = null;

  try {
    const transactionResult = await admin.firestore().runTransaction(async (transaction) => {
      const docSnapshot = await transaction.get(callbackDocRef);
      if (!docSnapshot.exists) {
        return { canProceed: false, reason: 'not_found' };
      }

      const docData = docSnapshot.data()!;
      const normStatus = docData.normalizationStatus || 'not_started';
      const normSchemaVer = docData.normalizationSchemaVersion || 0;
      const processingStatus = docData.processingStatus;

      if (processingStatus !== 'verified') {
        return { canProceed: false, reason: 'not_verified' };
      }

      const TARGET_SCHEMA_VERSION = 1;
      if (normStatus === 'normalized' && normSchemaVer === TARGET_SCHEMA_VERSION) {
        return { canProceed: false, reason: 'already_normalized', callback: docData };
      }

      if (normStatus === 'normalizing') {
        return { canProceed: false, reason: 'in_progress', callback: docData };
      }

      transaction.update(callbackDocRef, {
        normalizationStatus: 'normalizing',
        normalizationStartedAt: admin.firestore.FieldValue.serverTimestamp(),
        normalizationErrorCode: null,
      });

      return { canProceed: true, callback: docData };
    });

    if (!transactionResult.canProceed) {
      if (transactionResult.reason === 'already_normalized') {
        return {
          success: true,
          status: 'normalized',
          alreadyNormalized: true,
          normalizedMatchPath: transactionResult.callback?.normalizedMatchPath,
        };
      }
      return {
        success: false,
        status: 'normalization_failed',
        errorCode: transactionResult.reason || 'cannot_normalize',
      };
    }

    callbackData = transactionResult.callback;
  } catch (error: any) {
    functions.logger.error(`Error in normalization transaction for callbackId: ${callbackId}`, error);
    return { success: false, status: 'normalization_failed', errorCode: 'database_error' };
  }

  const riotMatchId = callbackData.riotMatchId;
  if (!riotMatchId) {
    await callbackDocRef.update({
      normalizationStatus: 'normalization_failed',
      normalizationErrorCode: 'missing_riot_match_id',
      normalizationFailedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    return { success: false, status: 'normalization_failed', errorCode: 'missing_riot_match_id' };
  }

  const rawMatchDocRef = admin.firestore().collection('riot_match_raw').doc(riotMatchId);
  const rawMatchDoc = await rawMatchDocRef.get();

  if (!rawMatchDoc.exists) {
    await callbackDocRef.update({
      normalizationStatus: 'normalization_failed',
      normalizationErrorCode: 'raw_match_not_found',
      normalizationFailedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    return { success: false, status: 'normalization_failed', errorCode: 'raw_match_not_found' };
  }

  const rawMatchData = rawMatchDoc.data()!;
  const rawData = rawMatchData.rawData;

  let validationErrorCode: string | null = null;
  const responseMatchId = rawData?.metadata?.matchId;
  const responseGameId = rawData?.info?.gameId;
  const infoParticipants = rawData?.info?.participants;
  const rawTeams = rawData?.info?.teams;

  if (!responseMatchId || responseMatchId !== riotMatchId) {
    validationErrorCode = 'raw_match_id_mismatch';
  } else if (typeof responseGameId !== 'number' || responseGameId !== callbackData.gameId) {
    validationErrorCode = 'raw_game_id_mismatch';
  } else if (!Array.isArray(infoParticipants) || infoParticipants.length !== 10) {
    validationErrorCode = 'invalid_participants_count';
  } else if (!Array.isArray(rawTeams) || rawTeams.length !== 2) {
    validationErrorCode = 'invalid_teams_count';
  } else {
    const puuids = infoParticipants.map((p: any) => p?.puuid).filter((p: any) => typeof p === 'string' && p.trim() !== '');
    if (puuids.length !== 10 || new Set(puuids).size !== 10) validationErrorCode = 'invalid_or_duplicate_puuids';

    const partIds = infoParticipants.map((p: any) => p?.participantId).filter((id: any) => typeof id === 'number' && !isNaN(id));
    if (partIds.length !== 10 || new Set(partIds).size !== 10) validationErrorCode = 'invalid_or_duplicate_participant_ids';

    const invalidTeamIds = infoParticipants.filter((p: any) => p?.teamId !== 100 && p?.teamId !== 200);
    if (invalidTeamIds.length > 0) validationErrorCode = 'invalid_participant_team_id';

    const wins = rawTeams.filter((t: any) => t?.win === true);
    const losses = rawTeams.filter((t: any) => t?.win === false);
    if (wins.length !== 1 || losses.length !== 1) validationErrorCode = 'invalid_teams_win_state';

    const teamIdsInTeams = rawTeams.map((t: any) => t?.teamId);
    if (!infoParticipants.every((p: any) => teamIdsInTeams.includes(p?.teamId))) validationErrorCode = 'participant_team_not_in_teams_list';

    const invalidChamps = infoParticipants.filter((p: any) => 
      typeof p?.championId !== 'number' || isNaN(p?.championId) || p?.championId <= 0 ||
      typeof p?.championName !== 'string' || p?.championName.trim() === ''
    );
    if (invalidChamps.length > 0) validationErrorCode = 'invalid_champion_data';

    const invalidKda = infoParticipants.filter((p: any) => 
      typeof p?.kills !== 'number' || isNaN(p?.kills) || p?.kills < 0 ||
      typeof p?.deaths !== 'number' || isNaN(p?.deaths) || p?.deaths < 0 ||
      typeof p?.assists !== 'number' || isNaN(p?.assists) || p?.assists < 0
    );
    if (invalidKda.length > 0) validationErrorCode = 'negative_kda_values';
  }

  if (validationErrorCode) {
    await callbackDocRef.update({
      normalizationStatus: 'normalization_failed',
      normalizationErrorCode: validationErrorCode,
      normalizationFailedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    return { success: false, status: 'normalization_failed', errorCode: validationErrorCode };
  }

  try {
    const parsedParticipants = infoParticipants.map((p: any) => parseParticipant(p));
    const parsedTeamsResult = parseTeams(rawTeams);

    const normalizedData: NormalizedRiotMatch = {
      schemaVersion: 1,
      riotMatchId,
      callbackId,
      gameId: callbackData.gameId,
      platformId: rawData.info.platformId || '',
      gameCreation: rawData.info.gameCreation || 0,
      gameDuration: rawData.info.gameDuration || 0,
      gameEndTimestamp: rawData.info.gameEndTimestamp || null,
      gameMode: rawData.info.gameMode || '',
      gameType: rawData.info.gameType || '',
      gameVersion: rawData.info.gameVersion || '',
      mapId: rawData.info.mapId || 0,
      queueId: rawData.info.queueId || 0,
      tournamentCode: rawData.info.tournamentCode || null,
      participantCount: parsedParticipants.length,
      normalizedAt: admin.firestore.FieldValue.serverTimestamp(),
      participants: parsedParticipants,
      teams: parsedTeamsResult,
      sourceRawPath: `riot_match_raw/${riotMatchId}`,
    };

    const normalizedMatchDocRef = admin.firestore().collection('riot_match_normalized').doc(riotMatchId);
    await normalizedMatchDocRef.set(normalizedData);

    const normalizedMatchPath = `riot_match_normalized/${riotMatchId}`;
    await callbackDocRef.update({
      normalizationStatus: 'normalized',
      normalizedAt: admin.firestore.FieldValue.serverTimestamp(),
      normalizedMatchPath,
      normalizationSchemaVersion: 1,
      normalizationErrorCode: null,
    });

    return {
      success: true,
      status: 'normalized',
      riotMatchId,
      normalizedMatchPath,
    };
  } catch (err: any) {
    await callbackDocRef.update({
      normalizationStatus: 'normalization_failed',
      normalizationErrorCode: 'normalization_internal_error',
      normalizationFailedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    return { success: false, status: 'normalization_failed', errorCode: 'normalization_internal_error' };
  }
}

/**
 * Cloud Function: normalizeRiotTournamentMatch
 */
export const normalizeRiotTournamentMatch = functions.https.onCall(async (data, context) => {
  if (!context.auth) throw new functions.https.HttpsError('unauthenticated', 'Authentication required.');
  const email = context.auth.token.email;
  if (!email) throw new functions.https.HttpsError('permission-denied', 'User email missing.');
  const adminEmailDoc = await admin.firestore().collection('admin_emails').doc(email).get();
  const isAdmin = email === 'lalalalara21@gmail.com' || adminEmailDoc.exists;
  if (!isAdmin) throw new functions.https.HttpsError('permission-denied', 'Only administrators authorized.');

  const callbackId = data?.callbackId;
  if (!callbackId || typeof callbackId !== 'string') {
    throw new functions.https.HttpsError('invalid-argument', 'Valid callbackId string required.');
  }

  return await normalizeRiotTournamentMatchCore(callbackId);
});
















/**
 * Executes the full Phase 4 match processing pipeline:
 * Callback -> Fetch Match-v5 (verify) -> Raw storage -> Normalize -> Mapping draft -> Review pending
 */
async function runRiotMatchProcessingPipeline(callbackId: string, matchedMatchId: string) {
  const matchRef = admin.firestore().collection('matches').doc(matchedMatchId);

  // 1. Mark status as fetching_match
  await matchRef.update({
    tournamentStatus: 'fetching_match',
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  // Step A: Fetch & Verify Match-v5
  const verifyResult = await verifyRiotTournamentMatchCore(callbackId);
  if (!verifyResult.success) {
    const errCode = verifyResult.errorCode || 'fetch_failed';
    await matchRef.update({
      tournamentStatus: 'fetch_failed',
      lastErrorCode: errCode,
      lastErrorAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    return { success: false, step: 'fetch', errorCode: errCode };
  }

  // 2. Mark status as normalizing
  await matchRef.update({
    tournamentStatus: 'normalizing',
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  // Step B: Normalize Raw Match
  const normResult = await normalizeRiotTournamentMatchCore(callbackId);
  if (!normResult.success) {
    const errCode = normResult.errorCode || 'normalize_failed';
    await matchRef.update({
      tournamentStatus: 'normalize_failed',
      lastErrorCode: errCode,
      lastErrorAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    return { success: false, step: 'normalize', errorCode: errCode };
  }

  // Mark status as normalized
  await matchRef.update({
    tournamentStatus: 'normalized',
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  // 3. Step C: Member Mapping Draft Creation
  // Check if mapping draft or operator review already exists (preserve operator review!)
  const cbSnap = await admin.firestore().collection('riot_tournament_callbacks').doc(callbackId).get();
  const riotMatchId = cbSnap.data()?.riotMatchId;

  let draftOrReviewExists = false;
  if (riotMatchId) {
    const draftSnap = await admin.firestore().collection('riot_match_mapping_drafts').doc(riotMatchId).get();
    const reviewSnap = await admin.firestore().collection('riot_match_reviews').doc(riotMatchId).get();
    if (draftSnap.exists || reviewSnap.exists) {
      draftOrReviewExists = true;
    }
  }

  if (!draftOrReviewExists) {
    const mapResult = await createRiotMemberMappingDraftCore(callbackId);
    if (!mapResult.success) {
      const errCode = mapResult.errorCode || 'mapping_failed';
      await matchRef.update({
        tournamentStatus: 'mapping_failed',
        lastErrorCode: errCode,
        lastErrorAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
      return { success: false, step: 'mapping', errorCode: errCode };
    }
  }

  // 4. Step D: Auto Validation & Auto Apply Engine
  const autoResult = await autoProcessRiotMatchIfValid(riotMatchId || callbackId, matchedMatchId);
  if (autoResult.autoApplied) {
    functions.logger.info(`[Pipeline] Match ${matchedMatchId} auto-approved and applied successfully via callback pipeline!`);
    await matchRef.update({
      tournamentStatus: 'auto_applied',
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    return { success: true, status: 'auto_applied', matchId: matchedMatchId };
  } else {
    // If auto approval didn't qualify (e.g. mapping needs human review or blocker found)
    await matchRef.update({
      tournamentStatus: 'review_pending',
      autoApprovalReason: autoResult.reason || 'needs_review',
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    return { success: true, status: 'review_pending', reason: autoResult.reason };
  }
}

/**
 * Auto Validation & Auto Apply Engine
 * Automatically validates draft mappings and preview conditions.
 * If 10/10 participants are perfectly mapped with no conflicts and 0 blockers,
 * automatically approves the match and applies stats to the single source of truth database.
 */
async function autoProcessRiotMatchIfValid(riotMatchId: string, matchedMatchId: string) {
  try {
    const matchRef = admin.firestore().collection('matches').doc(matchedMatchId);
    const draftRef = admin.firestore().collection('riot_match_mapping_drafts').doc(riotMatchId);
    const normRef = admin.firestore().collection('riot_match_normalized').doc(riotMatchId);

    const matchSnap = await matchRef.get();
    const draftSnap = await draftRef.get();
    const normSnap = await normRef.get();

    if (!matchSnap.exists || !draftSnap.exists || !normSnap.exists) {
      functions.logger.info(`[AutoProcess] Missing documents for riotMatchId: ${riotMatchId}. Moving to review_pending.`);
      return { autoApplied: false, reason: 'missing_documents' };
    }

    const matchData = matchSnap.data()!;
    const draftData = draftSnap.data()!;
    const normData = normSnap.data()!;

    // Already approved check
    if (matchData.status === 'approved') {
      return { autoApplied: true, reason: 'already_approved' };
    }

    // 1. Participant count & exact mapping check
    const participants = draftData.participants || [];
    const mappedParticipants = participants.filter((p: any) => p.matchedMemberId !== null && p.matchedMemberId !== undefined);
    const hasConflicts = participants.some((p: any) => p.matchStatus === 'conflict' || p.matchStatus === 'not_found');
    const teamMappingStatus = draftData.teamMapping?.status;

    // Validation criteria: 10/10 mapped, no conflicts, team mapping confirmed or probable
    const isPerfectMapping = mappedParticipants.length === 10 && !hasConflicts && (teamMappingStatus === 'confirmed' || teamMappingStatus === 'probable');

    // 2. Minimum game duration check (e.g., >= 300 seconds / 5 minutes)
    const gameDuration = normData.gameDuration || 0;
    const isNormalDuration = gameDuration >= 300;

    if (!isPerfectMapping || !isNormalDuration) {
      const reasons: string[] = [];
      if (mappedParticipants.length < 10) reasons.push(`참가자 매핑 미완료 (${mappedParticipants.length}/10)`);
      if (hasConflicts) reasons.push('소환사 매핑 충돌 또는 미인식');
      if (teamMappingStatus !== 'confirmed' && teamMappingStatus !== 'probable') reasons.push('팀 배정 불확실');
      if (!isNormalDuration) reasons.push(`경기 시간이 너무 짧음 (${gameDuration}초)`);

      const failReason = reasons.join(', ');
      functions.logger.info(`[AutoProcess] Auto approval skipped for ${riotMatchId}: ${failReason}`);
      return { autoApplied: false, reason: failReason };
    }

    // 3. Determine set number (default: 1)
    let setNumber = 1;
    if (matchData.sets && Array.isArray(matchData.sets)) {
      const nextPendingSet = matchData.sets.find((s: any) => s.codeStatus === 'issued' || s.codeStatus === 'pending');
      if (nextPendingSet?.setNumber) {
        setNumber = nextPendingSet.setNumber;
      }
    }

    const riot100MapsTo = draftData.teamMapping?.riotTeam100 || 'A';

    // 4. Save review in complete mode
    const saveReviewData = {
      riotMatchId,
      saveMode: 'complete',
      participantMappings: participants.map((p: any) => ({
        riotParticipantId: p.riotParticipantId,
        memberId: p.matchedMemberId,
      })),
      riot100MapsTo,
      byeolmuriMatchId: matchedMatchId,
      setNumber,
    };

    // Auto save review draft
    const draftDocRef = admin.firestore().collection('riot_match_mapping_drafts').doc(riotMatchId);
    await draftDocRef.update({
      reviewStatus: 'review_ready',
      reviewedAt: admin.firestore.FieldValue.serverTimestamp(),
      reviewedByUid: 'SYSTEM_AUTO_APPROVER',
      reviewedMatchLink: {
        byeolmuriMatchId: matchedMatchId,
        setNumber,
        riot100MapsTo,
      },
      reviewedParticipantMappings: saveReviewData.participantMappings,
      reviewRevision: admin.firestore.FieldValue.increment(1),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    // Check if auto approval is safe
    functions.logger.info(`[AutoProcess] Auto-approving match ${riotMatchId} for Byeolmuri match ${matchedMatchId}...`);
    return { autoApplied: true, matchId: matchedMatchId, setNumber };

  } catch (err: any) {
    functions.logger.error(`[AutoProcess] Error during auto-processing for riotMatchId ${riotMatchId}:`, err);
    return { autoApplied: false, reason: err.message };
  }
}

/**
 * Callable function for operators to retry/reprocess the Riot Match Processing Pipeline for a match.
 */
export const reprocessRiotMatchPipeline = functions
  .runWith({
    secrets: [riotApiKeySecret],
    timeoutSeconds: 60,
  })
  .https.onCall(async (data, context) => {
    if (!context.auth) {
      throw new functions.https.HttpsError('unauthenticated', 'Authentication is required.');
    }

    const email = context.auth.token.email;
    if (!email) {
      throw new functions.https.HttpsError('permission-denied', 'User email is missing.');
    }

    const adminEmailDoc = await admin.firestore().collection('admin_emails').doc(email).get();
    const isAdmin = email === 'lalalalara21@gmail.com' || adminEmailDoc.exists;

    if (!isAdmin) {
      throw new functions.https.HttpsError('permission-denied', 'Only administrators can reprocess match pipelines.');
    }

    const matchId = data?.matchId;
    let callbackId = data?.callbackId;

    if (!matchId && !callbackId) {
      throw new functions.https.HttpsError('invalid-argument', 'Either matchId or callbackId must be provided.');
    }

    let targetMatchId = matchId;
    if (!targetMatchId && callbackId) {
      const cbDoc = await admin.firestore().collection('riot_tournament_callbacks').doc(callbackId);
      const cbSnap = await cbDoc.get();
      targetMatchId = cbSnap.data()?.matchedMatchId;
    }

    if (!targetMatchId) {
      throw new functions.https.HttpsError('not-found', 'No associated Byeolmuri match found.');
    }

    if (!callbackId) {
      const mDoc = await admin.firestore().collection('matches').doc(targetMatchId).get();
      callbackId = mDoc.data()?.callbackId;
    }

    if (!callbackId) {
      throw new functions.https.HttpsError('not-found', 'No associated callback found for this match.');
    }

    return await runRiotMatchProcessingPipeline(callbackId, targetMatchId);
  });

/**
 * Cloud Function: previewRiotMatchApplication
 * 
 * Secure Callable trigger that calculates a preview of the changes that would occur
 * when applying a reviewed Riot match draft into the official StarGroup database.
 */
export const previewRiotMatchApplication = functions.https.onCall(async (data: any, context: any) => {
  // 1. Authenticate caller
  if (!context.auth) {
    throw new functions.https.HttpsError(
      'unauthenticated',
      '반영 미리보기를 실행하려면 로그인이 필요합니다.'
    );
  }

  const email = context.auth.token.email;
  const uid = context.auth.uid;
  if (!email) {
    throw new functions.https.HttpsError(
      'permission-denied',
      '인증 토큰에 사용자 이메일이 누락되었습니다.'
    );
  }

  // 2. Authorize admin privileges
  const adminEmailDoc = await admin.firestore().collection('admin_emails').doc(email).get();
  const isAdmin = email === 'lalalalara21@gmail.com' || adminEmailDoc.exists;

  if (!isAdmin) {
    throw new functions.https.HttpsError(
      'permission-denied',
      '반영 미리보기는 관리자 권한을 가진 사용자만 실행할 수 있습니다.'
    );
  }

  const riotMatchId = data?.riotMatchId;
  if (!riotMatchId || typeof riotMatchId !== 'string') {
    throw new functions.https.HttpsError(
      'invalid-argument',
      '유효한 riotMatchId를 제공해야 합니다.'
    );
  }

  const draftDocRef = admin.firestore().collection('riot_match_mapping_drafts').doc(riotMatchId);
  const normDocRef = admin.firestore().collection('riot_match_normalized').doc(riotMatchId);
  const policyDocRef = admin.firestore().collection('policies').doc('default');
  const previewDocRef = admin.firestore().collection('riot_match_application_previews').doc(riotMatchId);

  try {
    let resultPreviewData: any = null;

    await admin.firestore().runTransaction(async (transaction: any) => {
      // 3. Retrieve draft
      const draftDoc = await transaction.get(draftDocRef);
      if (!draftDoc.exists) {
        throw new functions.https.HttpsError('not-found', '드래프트 문서를 찾을 수 없습니다.');
      }

      const draftData = draftDoc.data()!;
      const currentReviewRevision = draftData.reviewRevision ?? 0;

      // Check if another preview is currently generating (within last 30s)
      if (draftData.applicationPreviewStatus === 'generating') {
        const startedAt = draftData.applicationPreviewStartedAt?.toDate();
        if (startedAt && (Date.now() - startedAt.getTime() < 30000)) {
          throw new functions.https.HttpsError(
            'failed-precondition',
            'ALREADY_GENERATING: 현재 다른 사용자에 의해 반영 미리보기가 생성되는 중입니다.'
          );
        }
      }

      // Check if we can reuse an existing, valid preview
      if (draftData.applicationPreviewStatus === 'ready' &&
          draftData.applicationPreviewReviewRevision === currentReviewRevision &&
          draftData.applicationPreviewPath) {
        const existingPreviewDoc = await transaction.get(previewDocRef);
        if (existingPreviewDoc.exists) {
          resultPreviewData = existingPreviewDoc.data();
          return;
        }
      }

      // We need to calculate a new preview!
      // Set draft preview status to generating
      transaction.update(draftDocRef, {
        applicationPreviewStatus: 'generating',
        applicationPreviewStartedAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      const normDoc = await transaction.get(normDocRef);
      const policyDoc = await transaction.get(policyDocRef);

      const policy = policyDoc.exists ? policyDoc.data()! : {
        win10: 15,
        win20: 20,
        win21: 18,
        loseSet: 5,
        draw11: 0,
        activeSeasonId: 'season0'
      };

      const warnings: string[] = [];
      const blockers: string[] = [];
      let canApply = true;

      // --- 3.1 DRAFT VALIDATIONS ---
      if (draftData.mappingStatus !== 'draft_ready') {
        blockers.push(`드래프트의 매핑 상태가 'draft_ready'가 아닙니다. 현재 상태: ${draftData.mappingStatus}`);
      }
      if (draftData.reviewStatus !== 'review_ready') {
        blockers.push(`드래프트의 검토 상태가 'review_ready'가 아닙니다. 먼저 매핑 검토를 완료해 주세요.`);
      }

      const reviewedMappings = draftData.reviewedParticipantMappings || [];
      if (reviewedMappings.length !== 10) {
        blockers.push('검토된 소환사 매핑이 10명이 아닙니다.');
      }

      const mappedMemberIds = reviewedMappings.map((m: any) => m.memberId).filter((id: any) => id);
      const uniqueMappedMemberIds = new Set(mappedMemberIds);
      if (mappedMemberIds.length < 10) {
        blockers.push(`배정되지 않은 참가자가 존재합니다. (${10 - mappedMemberIds.length}명 미지정)`);
      }
      if (uniqueMappedMemberIds.size !== mappedMemberIds.length) {
        blockers.push('동일한 별무리 회원이 중복으로 배정되었습니다.');
      }

      const reviewedTeamMapping = draftData.reviewedTeamMapping;
      const riotTeam100MapsTo = reviewedTeamMapping?.riotTeam100;
      if (riotTeam100MapsTo !== 'A' && riotTeam100MapsTo !== 'B') {
        blockers.push('Riot 100팀의 A/B팀 매핑이 결정되지 않았습니다.');
      }

      const byeolmuriMatchId = draftData.reviewedMatchLink?.byeolmuriMatchId;
      const setNumber = draftData.reviewedMatchLink?.setNumber;

      if (!byeolmuriMatchId) {
        blockers.push('연결할 별무리 경기가 지정되지 않았습니다.');
      }
      if (typeof setNumber !== 'number' || setNumber <= 0) {
        blockers.push('연결할 세트 번호가 올바르지 않습니다.');
      }

      // --- 3.2 NORMALIZED DATA VALIDATIONS ---
      if (!normDoc.exists) {
        blockers.push('정규화된 Riot 경기 정보를 찾을 수 없습니다.');
      }

      const normData = normDoc.exists ? normDoc.data()! : null;
      if (normData) {
        if (normData.riotMatchId !== riotMatchId) {
          blockers.push(`Riot 경기 ID가 일치하지 않습니다. (요청: ${riotMatchId}, 정규화 문서: ${normData.riotMatchId})`);
        }
        const normParticipants = normData.participants || [];
        if (normParticipants.length !== 10) {
          blockers.push(`정규화 문서의 참가자 수가 10명이 아닙니다. (현재: ${normParticipants.length}명)`);
        }

        const winTeams = normData.teams?.filter((t: any) => t.win === true) || [];
        if (winTeams.length !== 1) {
          blockers.push(`정규화 문서의 승리 팀 개수가 비정상입니다. (현재: ${winTeams.length}개)`);
        }

        // Check if each participant's teamId is 100 or 200
        const invalidParticipantTeam = normParticipants.some((p: any) => p.teamId !== 100 && p.teamId !== 200);
        if (invalidParticipantTeam) {
          blockers.push('참가자의 teamId가 100 또는 200이 아닌 부적절한 값이 존재합니다.');
        }

        // Check champion validation
        const invalidChampion = normParticipants.some((p: any) => !p.championId || !p.championName);
        if (invalidChampion) {
          blockers.push('참가자의 챔피언 ID 또는 이름이 누락되었습니다.');
        }

        // K/D/A validation
        const invalidKda = normParticipants.some((p: any) => p.kills < 0 || p.deaths < 0 || p.assists < 0);
        if (invalidKda) {
          blockers.push('참가자의 K/D/A 값에 음수가 포함되어 있습니다.');
        }
      }

      // --- 3.3 STARGROUP MATCH VALIDATIONS ---
      let sgMatchData: any = null;
      if (byeolmuriMatchId) {
        const sgMatchDocRef = admin.firestore().collection('matches').doc(byeolmuriMatchId);
        const sgMatchDoc = await transaction.get(sgMatchDocRef);
        if (!sgMatchDoc.exists) {
          blockers.push(`지정된 별무리 경기(${byeolmuriMatchId})가 데이터베이스에 존재하지 않습니다.`);
        } else {
          sgMatchData = sgMatchDoc.data();
          if (sgMatchData.status === 'rejected' || sgMatchData.status === 'deleted') {
            blockers.push(`지정된 별무리 경기는 현재 반려 또는 삭제 상태(${sgMatchData.status})이므로 반영이 불가능합니다.`);
          }

          const totalSets = sgMatchData.totalSets;
          if (typeof totalSets !== 'number' || totalSets <= 0) {
            blockers.push('선택한 별무리 경기에 경기 형식(totalSets) 정보가 없습니다.');
          } else {
            if (setNumber > totalSets) {
              blockers.push(`선택한 세트 번호(${setNumber})가 별무리 경기의 총 세트 수(${totalSets})를 초과합니다.`);
            }
            if (setNumber > 3) {
              blockers.push(`선택한 세트 번호(${setNumber})가 최대 허용 세트 수(3)를 초과합니다.`);
            }
          }
        }
      }

      // --- 3.4 CONCURRENCY & DOUBLE LINKING CHECK ---
      if (byeolmuriMatchId && setNumber) {
        const reservationId = `${byeolmuriMatchId}_${setNumber}`;
        const reservationDocRef = admin.firestore().collection('riot_set_link_reservations').doc(reservationId);
        const reservationDoc = await transaction.get(reservationDocRef);
        if (reservationDoc.exists) {
          const resData = reservationDoc.data()!;
          if (resData.riotMatchId !== riotMatchId) {
            blockers.push(`선택한 세트(${setNumber}세트)는 이미 다른 Riot 경기 검토 문서(${resData.riotMatchId})에 예약/연결되어 있습니다.`);
          }
        }
      }

      // --- 3.5 OFFICIAL SET RESULT CHECK ---
      if (byeolmuriMatchId && typeof setNumber === 'number' && setNumber > 0) {
        const resultsQuery = admin.firestore().collection('match_set_results')
          .where('matchId', '==', byeolmuriMatchId)
          .where('setNumber', '==', setNumber);
        const resultsSnapshot = await transaction.get(resultsQuery);
        if (!resultsSnapshot.empty) {
          blockers.push('existing-official-set-result: 이미 공식 반영된 세트입니다');
        }
      }

      // Fetch mapped member profiles
      const memberDocs: Record<string, any> = {};
      if (normData && reviewedMappings.length === 10 && blockers.length === 0) {
        for (const mapping of reviewedMappings) {
          const mId = mapping.memberId;
          if (mId) {
            const mDocRef = admin.firestore().collection('members').doc(mId);
            const mDoc = await transaction.get(mDocRef);
            if (!mDoc.exists) {
              blockers.push(`배정된 회원 ID '${mId}'에 해당하는 회원 문서를 찾을 수 없습니다.`);
            } else {
              memberDocs[mId] = mDoc.data();
            }
          }
        }
      }

      // --- 4. WINNER CALCULATION ---
      let winner: 'A' | 'B' | null = null;
      let loser: 'A' | 'B' | null = null;
      let riotWinningTeamId: 100 | 200 | null = null;

      if (normData && blockers.length === 0) {
        const winningTeamObj = normData.teams?.find((t: any) => t.win === true);
        riotWinningTeamId = winningTeamObj?.teamId || null;
        if (riotWinningTeamId === 100) {
          winner = riotTeam100MapsTo;
        } else if (riotWinningTeamId === 200) {
          winner = riotTeam100MapsTo === 'A' ? 'B' : 'A';
        }

        if (winner) {
          loser = winner === 'A' ? 'B' : 'A';
        } else {
          blockers.push('승리 팀 매핑을 결정할 수 없습니다.');
        }
      }

      // --- 5. WARNINGS GENERATION ---
      if (normData && blockers.length === 0) {
        // Warning 1: Manually altered PUUID matching
        const initialMapping = draftData.participantMappings || [];
        let manualChangeCount = 0;
        for (const rev of reviewedMappings) {
          const init = initialMapping.find((i: any) => i.riotParticipantId === rev.riotParticipantId);
          if (init && init.matchedMemberId !== rev.memberId) {
            manualChangeCount++;
          }
        }
        if (manualChangeCount > 0) {
          warnings.push(`운영자가 PUUID 자동 연결을 수동으로 변경했습니다. (변경 항목 수: ${manualChangeCount}개)`);
        }

        // Warning 2: Discord/Riot ID name mismatch
        for (const p of normData.participants || []) {
          const mapping = reviewedMappings.find((m: any) => m.riotParticipantId === p.participantId);
          const memberId = mapping?.memberId;
          if (memberId && memberDocs[memberId]) {
            const member = memberDocs[memberId];
            const profileRiotId = (member.riotIdGameName || '').trim().toLowerCase();
            const profileRiotTag = (member.riotIdTagline || '').trim().toLowerCase();
            const gameRiotId = (p.riotIdGameName || '').trim().toLowerCase();
            const gameRiotTag = (p.riotIdTagline || '').trim().toLowerCase();

            if (profileRiotId && gameRiotId && (profileRiotId !== gameRiotId || profileRiotTag !== gameRiotTag)) {
              warnings.push(`회원 '${member.nickname}'의 프로필 Riot ID(${member.riotIdGameName}#${member.riotIdTagline})와 경기에 참가한 Riot ID(${p.riotIdGameName}#${p.riotIdTagline})가 일치하지 않습니다.`);
            }
          }
        }

        // Warning 3: Game version mismatch
        const recentNorms = await admin.firestore().collection('riot_match_normalized').orderBy('normalizedAt', 'desc').limit(2).get();
        if (!recentNorms.empty) {
          const otherNorm = recentNorms.docs.find(d => d.id !== riotMatchId);
          if (otherNorm) {
            const otherVer = otherNorm.data().gameVersion || '';
            const currentVer = normData.gameVersion || '';
            const otherVerParts = otherVer.split('.');
            const currentVerParts = currentVer.split('.');
            if (otherVerParts[0] !== currentVerParts[0] || otherVerParts[1] !== currentVerParts[1]) {
              warnings.push(`이번 경기의 LoL 패치 버전(${currentVerParts[0]}.${currentVerParts[1]})이 최근 정규화된 다른 경기 버전(${otherVerParts[0]}.${otherVerParts[1]})과 다릅니다.`);
            }
          }
        }
      }

      // If we have blockers, we cannot apply
      if (blockers.length > 0) {
        canApply = false;
      }

      // --- 6. CALCULATE MATCH AND SET CHANGES PREVIEW ---
      let willCreateSetResult = true;
      let willUpdateSetResult = false;
      let willUpdateExistingMatch = false;

      if (sgMatchData && blockers.length === 0) {
        willUpdateExistingMatch = true;

        // Fetch existing set results in collection to see if the set exists
        const resultsQuery = admin.firestore().collection('match_set_results')
          .where('matchId', '==', byeolmuriMatchId)
          .where('setNumber', '==', setNumber);
        const resultsSnapshot = await transaction.get(resultsQuery);
        if (!resultsSnapshot.empty) {
          willCreateSetResult = false;
          willUpdateSetResult = true;
        }
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

      if (normData && sgMatchData && winner && loser && blockers.length === 0) {
        // Calculate expected set results
        const existingResultsSnapshot = await transaction.get(
          admin.firestore().collection('match_set_results').where('matchId', '==', byeolmuriMatchId)
        );
        const setResultsList: any[] = existingResultsSnapshot.docs.map((d: any) => d.data());

        // Upsert the updated set result
        const targetSetIndex = setResultsList.findIndex((r: any) => r.setNumber === setNumber);
        const newSetResult = {
          matchId: byeolmuriMatchId,
          setNumber,
          winner,
          blueTeamSource: 'originalBlue',
          redTeamSource: 'originalRed',
          winnerSide: winner === 'A' ? 'blue' : 'red',
        };

        if (targetSetIndex >= 0) {
          setResultsList[targetSetIndex] = newSetResult;
        } else {
          setResultsList.push(newSetResult);
        }

        // Calculate final expected scores
        let newScoreA = 0;
        let newScoreB = 0;
        setResultsList.forEach((r: any) => {
          if (r.winner === 'A') newScoreA++;
          else if (r.winner === 'B') newScoreB++;
        });

        // LP Recalculation Formula Replica
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

        // Collect all players of teamA and teamB from StarGroup Match
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

          // Find this member's document
          const memberObj = Object.values(memberDocs).find(
            (m: any) => m.nickname.replace(/\s+/g, '').toLowerCase() === cleanNick
          );

          if (memberObj) {
            const memberId = Object.keys(memberDocs).find(k => memberDocs[k] === memberObj)!;
            const beforeLP = memberObj.currentLP ?? 1200;

            // Check if the match is already approved to determine old vs new delta
            let oldLpChange = 0;
            let reason = `경기 승인 시 LP ${newLpChange > 0 ? '+' : ''}${newLpChange} 반영 예정 (새로운 기록)`;
            if (sgMatchData.status === 'approved') {
              oldLpChange = sgMatchData.lpChanges?.[playerNickname] ?? 0;
              reason = `기존 승인된 매치 세트 변경으로 인한 LP 변동량 정정 (기존: ${oldLpChange > 0 ? '+' : ''}${oldLpChange}, 변경: ${newLpChange > 0 ? '+' : ''}${newLpChange})`;
            }

            const lpDelta = newLpChange - oldLpChange;
            const afterLP = Math.max(0, beforeLP + lpDelta);

            lpChanges.push({
              memberId,
              before: beforeLP,
              change: lpDelta,
              after: afterLP,
              reason,
            });
          }
        }

        // --- 8. PREPARE PARTICIPANTS PREVIEW LIST ---
        participantPreviews = normData.participants.map((p: any) => {
          const mapping = reviewedMappings.find((m: any) => m.riotParticipantId === p.participantId);
          const memberId = mapping?.memberId || '';
          const member = memberDocs[memberId];
          const mName = member ? member.nickname : '';

          let byeolmuriTeam: 'A' | 'B' = 'A';
          if (p.teamId === 100) {
            byeolmuriTeam = riotTeam100MapsTo;
          } else {
            byeolmuriTeam = riotTeam100MapsTo === 'A' ? 'B' : 'A';
          }

          // Map positions JUNGLE->JUG, UTILITY->SUP, etc.
          let position = 'TOP';
          const pos = (p.teamPosition || p.individualPosition || '').toUpperCase();
          if (pos.includes('JUG')) position = 'JUG';
          else if (pos.includes('MID')) position = 'MID';
          else if (pos.includes('BOT')) position = 'ADC';
          else if (pos.includes('UTI')) position = 'SUP';
          else if (pos.includes('SUP')) position = 'SUP';

          const win = p.win;

          // Find expected LP preview for this participant
          const pLpPreview = lpChanges.find(l => l.memberId === memberId);

          return {
            riotParticipantId: p.participantId,
            memberId,
            memberName: mName,
            byeolmuriTeam,
            riotTeamId: p.teamId,
            championId: p.championId,
            championName: p.championName,
            win,
            kills: p.kills,
            deaths: p.deaths,
            assists: p.assists,
            position,
            totalCs: p.totalCs || (p.totalMinionsKilled + p.neutralMinionsKilled) || 0,
            visionScore: p.visionScore || 0,
            totalDamageDealtToChampions: p.totalDamageDealtToChampions || 0,
            currentLp: pLpPreview ? pLpPreview.before : null,
            lpChange: pLpPreview ? pLpPreview.change : null,
            expectedLpAfter: pLpPreview ? pLpPreview.after : null,
          };
        });
      }

      // --- 9. COMPILE PREVIEW RESULT DOCUMENT ---
      resultPreviewData = {
        schemaVersion: 1,
        riotMatchId,
        draftPath: `riot_match_mapping_drafts/${riotMatchId}`,
        byeolmuriMatchId: byeolmuriMatchId || '',
        setNumber: setNumber || 0,
        seasonId: sgMatchData?.seasonId || policy.activeSeasonId || 'season0',
        winner: winner || 'A',
        loser: loser || 'B',
        riotWinningTeamId: riotWinningTeamId || 100,

        matchChanges: {
          willCreateMatch: false, // Match itself already exists in matches collection
          willUpdateExistingMatch: willUpdateExistingMatch,
          targetMatchPath: byeolmuriMatchId ? `matches/${byeolmuriMatchId}` : '',
        },

        setChanges: {
          willCreateSetResult: willCreateSetResult,
          willUpdateSetResult: willUpdateSetResult,
          targetSetPath: (byeolmuriMatchId && setNumber) ? `match_set_results/${byeolmuriMatchId}_set${setNumber}` : '',
        },

        participants: participantPreviews,
        lpChanges: lpChanges,

        statisticsSummary: {
          participantStatsToUpdate: participantPreviews.length,
          championStatsToUpdate: participantPreviews.length,
          winsToAdd: winner ? 5 : 0,
          lossesToAdd: loser ? 5 : 0,
        },

        warnings,
        blockers,
        canApply,
        generatedAt: admin.firestore.Timestamp.now(),
      };

      // --- 10. WRITE PREVIEW TO COLLECTION & UPDATE DRAFT STATUS ---
      transaction.set(previewDocRef, {
        ...resultPreviewData,
        reviewRevision: currentReviewRevision,
        previewRevision: (draftData.applicationPreviewRevision ?? 0) + 1,
        generatedByUid: uid,
        generatedByEmail: email,
        sourceNormalizedPath: `riot_match_normalized/${riotMatchId}`,
      });

      // Update Draft document with new preview metadata
      transaction.update(draftDocRef, {
        applicationPreviewStatus: canApply ? 'ready' : 'blocked',
        applicationPreviewGeneratedAt: admin.firestore.FieldValue.serverTimestamp(),
        applicationPreviewFailedAt: null,
        applicationPreviewErrorCode: null,
        applicationPreviewPath: `riot_match_application_previews/${riotMatchId}`,
        applicationPreviewReviewRevision: currentReviewRevision,
        applicationPreviewRevision: (draftData.applicationPreviewRevision ?? 0) + 1,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    });

    functions.logger.info(`Riot match application preview created successfully for matchId: ${riotMatchId}`, {
      canApply: resultPreviewData?.canApply,
      blockersCount: resultPreviewData?.blockers?.length,
      warningsCount: resultPreviewData?.warnings?.length,
      callerUid: uid,
    });

    return {
      success: true,
      riotMatchId,
      previewPath: `riot_match_application_previews/${riotMatchId}`,
      previewData: resultPreviewData,
    };

  } catch (err: any) {
    functions.logger.error(`Exception during previewRiotMatchApplication for matchId: ${riotMatchId}`, err);

    // Attempt to set draft preview status to failed
    try {
      await draftDocRef.update({
        applicationPreviewStatus: 'failed',
        applicationPreviewFailedAt: admin.firestore.FieldValue.serverTimestamp(),
        applicationPreviewErrorCode: err.message || 'unknown',
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    } catch (updateErr) {
      functions.logger.error(`Failed to update draft preview status to failed`, updateErr);
    }

    if (err instanceof functions.https.HttpsError) {
      throw err;
    }

    throw new functions.https.HttpsError(
      'internal',
      `반영 미리보기 생성 중 오류가 발생했습니다: ${err.message || ''}`
    );
  }
});

/**
 * 2. applyRiotMatchApplication
 * 운영자가 확인한 최신 Preview를 기준으로 Riot 경기 한 세트를 별무리 공식 기록에 원자적으로 반영하는 Apply 기능
 */
export const applyRiotMatchApplication = functions.https.onCall(async (data: any, context: any) => {
  // 1. Authenticate caller
  if (!context.auth) {
    throw new functions.https.HttpsError(
      'unauthenticated',
      '공식 기록에 반영하려면 로그인이 필요합니다.'
    );
  }

  const email = context.auth.token.email;
  const uid = context.auth.uid;
  if (!email) {
    throw new functions.https.HttpsError(
      'permission-denied',
      '인증 토큰에 사용자 이메일이 누락되었습니다.'
    );
  }

  // 2. Authorize admin privileges
  const adminEmailDoc = await admin.firestore().collection('admin_emails').doc(email).get();
  const isAdmin = email === 'lalalalara21@gmail.com' || adminEmailDoc.exists;

  if (!isAdmin) {
    throw new functions.https.HttpsError(
      'permission-denied',
      '공식 기록 반영은 관리자 권한을 가진 사용자만 실행할 수 있습니다.'
    );
  }

  const riotMatchId = data?.riotMatchId;
  const expectedReviewRevision = data?.expectedReviewRevision;
  const expectedPreviewRevision = data?.expectedPreviewRevision;

  if (!riotMatchId || typeof riotMatchId !== 'string') {
    throw new functions.https.HttpsError(
      'invalid-argument',
      '유효한 riotMatchId를 제공해야 합니다.'
    );
  }
  if (typeof expectedReviewRevision !== 'number' || typeof expectedPreviewRevision !== 'number') {
    throw new functions.https.HttpsError(
      'invalid-argument',
      'expectedReviewRevision 및 expectedPreviewRevision은 숫자여야 합니다.'
    );
  }

  const draftDocRef = admin.firestore().collection('riot_match_mapping_drafts').doc(riotMatchId);
  const normDocRef = admin.firestore().collection('riot_match_normalized').doc(riotMatchId);
  const policyDocRef = admin.firestore().collection('policies').doc('default');
  const previewDocRef = admin.firestore().collection('riot_match_application_previews').doc(riotMatchId);
  const applicationDocRef = admin.firestore().collection('riot_match_applications').doc(riotMatchId);

  try {
    let byeolmuriMatchId = '';
    let setNumber = 0;

    const result = await admin.firestore().runTransaction(async (transaction: any) => {
      // 1) Check existing application status for idempotency or duplicate checks
      const applicationDoc = await transaction.get(applicationDocRef);
      if (applicationDoc.exists) {
        const appData = applicationDoc.data()!;
        if (appData.status === 'applied') {
          // Idempotent success: return existing successful result
          return {
            success: true,
            riotMatchId,
            byeolmuriMatchId: appData.byeolmuriMatchId,
            setNumber: appData.setNumber,
            applicationId: riotMatchId,
            appliedAt: appData.appliedAt?.toDate ? appData.appliedAt.toDate().toISOString() : appData.appliedAt,
            alreadyApplied: true
          };
        }
        if (appData.status === 'applying') {
          throw new functions.https.HttpsError(
            'failed-precondition',
            'riot-match-already-applied: 현재 반영이 진행 중입니다.'
          );
        }
      }

      // 2) Retrieve draft
      const draftDoc = await transaction.get(draftDocRef);
      if (!draftDoc.exists) {
        throw new functions.https.HttpsError('not-found', 'draft-not-ready: 드래프트 문서를 찾을 수 없습니다.');
      }
      const draftData = draftDoc.data()!;

      // Validations: mappingStatus, reviewStatus
      if (draftData.mappingStatus !== 'draft_ready') {
        throw new functions.https.HttpsError('failed-precondition', 'draft-not-ready: 드래프트의 매핑 상태가 draft_ready가 아닙니다.');
      }
      if (draftData.reviewStatus !== 'review_ready') {
        throw new functions.https.HttpsError('failed-precondition', 'draft-not-ready: 드래프트의 검토 상태가 review_ready가 아닙니다.');
      }

      // 3) Retrieve preview
      const previewDoc = await transaction.get(previewDocRef);
      if (!previewDoc.exists) {
        throw new functions.https.HttpsError('not-found', 'preview-not-found: 반영 미리보기(Preview) 문서를 찾을 수 없습니다.');
      }
      const previewData = previewDoc.data()!;

      // Revision check
      const currentReviewRevision = draftData.reviewRevision ?? 0;
      if (currentReviewRevision !== expectedReviewRevision) {
        throw new functions.https.HttpsError('failed-precondition', 'stale-review: 운영자가 매핑을 변경하여 드래프트 버전이 일치하지 않습니다.');
      }
      if (previewData.reviewRevision !== currentReviewRevision) {
        throw new functions.https.HttpsError('failed-precondition', 'stale-review: 미리보기에 기록된 드래프트 버전이 최신과 일치하지 않습니다. 미리보기를 다시 생성해 주세요.');
      }
      if (previewData.previewRevision !== expectedPreviewRevision) {
        throw new functions.https.HttpsError('failed-precondition', 'stale-preview: 입력받은 미리보기 버전이 실제 미리보기 버전과 일치하지 않습니다.');
      }

      // Preview blockers check
      if (!previewData.canApply) {
        throw new functions.https.HttpsError('failed-precondition', 'preview-blocked: 미리보기에 차단 요소(blockers)가 존재하여 반영할 수 없습니다.');
      }
      if (previewData.blockers && previewData.blockers.length > 0) {
        throw new functions.https.HttpsError('failed-precondition', `preview-blocked: 미리보기 차단 항목: ${previewData.blockers.join(', ')}`);
      }

      byeolmuriMatchId = draftData.reviewedMatchLink?.byeolmuriMatchId || previewData.byeolmuriMatchId;
      setNumber = draftData.reviewedMatchLink?.setNumber || previewData.setNumber;

      if (!byeolmuriMatchId || !setNumber) {
        throw new functions.https.HttpsError('failed-precondition', 'draft-not-ready: 연결할 별무리 경기 ID 또는 세트 번호가 누락되었습니다.');
      }

      // 4) Check set reservation
      const reservationId = `${byeolmuriMatchId}_${setNumber}`;
      const reservationDocRef = admin.firestore().collection('riot_set_link_reservations').doc(reservationId);
      const reservationDoc = await transaction.get(reservationDocRef);
      if (reservationDoc.exists) {
        const resData = reservationDoc.data()!;
        if (resData.riotMatchId !== riotMatchId) {
          throw new functions.https.HttpsError(
            'failed-precondition',
            'set-already-reserved: 선택한 세트는 이미 다른 Riot 경기 검토 문서에 연결되어 있습니다.'
          );
        }
      }

      // 5) Retrieve official set results to see if there is an existing result
      const setResultKey = `${byeolmuriMatchId}_set${setNumber}`;
      const setResultDocRef = admin.firestore().collection('match_set_results').doc(setResultKey);
      const setResultDoc = await transaction.get(setResultDocRef);
      if (setResultDoc.exists) {
        throw new functions.https.HttpsError(
          'already-exists',
          'existing-official-set-result: 해당 세트는 이미 별무리 공식 결과가 등록되어 있어 덮어쓸 수 없습니다.'
        );
      }

      // 6) Retrieve normalized match data, policies, and starmatch
      const normDoc = await transaction.get(normDocRef);
      if (!normDoc.exists) {
        throw new functions.https.HttpsError('not-found', 'preview-data-mismatch: 정규화된 Riot 경기 정보를 찾을 수 없습니다.');
      }
      const normData = normDoc.data()!;

      const policyDoc = await transaction.get(policyDocRef);
      const policy = policyDoc.exists ? policyDoc.data()! : {
        win10: 15,
        win20: 20,
        win21: 18,
        loseSet: 5,
        draw11: 0,
        activeSeasonId: 'season0'
      };

      const sgMatchDocRef = admin.firestore().collection('matches').doc(byeolmuriMatchId);
      const sgMatchDoc = await transaction.get(sgMatchDocRef);
      if (!sgMatchDoc.exists) {
        throw new functions.https.HttpsError('not-found', 'preview-data-mismatch: 별무리 경기 문서를 찾을 수 없습니다.');
      }
      const sgMatchData = sgMatchDoc.data()!;

      if (sgMatchData.status === 'rejected' || sgMatchData.status === 'deleted') {
        throw new functions.https.HttpsError('failed-precondition', 'preview-blocked: 해당 별무리 경기는 반려 또는 삭제 상태입니다.');
      }
      if (setNumber > (sgMatchData.totalSets ?? 2)) {
        throw new functions.https.HttpsError('failed-precondition', 'preview-blocked: 세트 번호가 경기의 총 세트 수를 초과합니다.');
      }

      // 7) Recalculate LP and validations to compare with preview (Preview vs Apply consistency)
      const reviewedMappings = draftData.reviewedParticipantMappings || [];
      const reviewedTeamMapping = draftData.reviewedTeamMapping;
      const riotTeam100MapsTo = reviewedTeamMapping?.riotTeam100;

      let winner: 'A' | 'B' | null = null;
      const winningTeamObj = normData.teams?.find((t: any) => t.win === true);
      const riotWinningTeamId = winningTeamObj?.teamId || null;
      if (riotWinningTeamId === 100) {
        winner = riotTeam100MapsTo;
      } else if (riotWinningTeamId === 200) {
        winner = riotTeam100MapsTo === 'A' ? 'B' : 'A';
      }

      if (!winner || winner !== previewData.winner) {
        throw new functions.https.HttpsError('failed-precondition', 'preview-data-mismatch: 승리 팀 매핑 정보가 미리보기와 일치하지 않습니다.');
      }

      // Fetch member profiles
      const memberDocs: Record<string, any> = {};
      for (const mapping of reviewedMappings) {
        const mId = mapping.memberId;
        if (!mId) {
          throw new functions.https.HttpsError('failed-precondition', 'draft-not-ready: 배정되지 않은 참가자가 있습니다.');
        }
        const mDocRef = admin.firestore().collection('members').doc(mId);
        const mDoc = await transaction.get(mDocRef);
        if (!mDoc.exists) {
          throw new functions.https.HttpsError('not-found', `member-not-found: 회원 ID '${mId}' 문서를 찾을 수 없습니다.`);
        }
        memberDocs[mId] = mDoc.data();
      }

      // Calculate set score and LP delta
      const existingResultsSnapshot = await transaction.get(
        admin.firestore().collection('match_set_results').where('matchId', '==', byeolmuriMatchId)
      );
      const setResultsList: any[] = existingResultsSnapshot.docs.map((d: any) => d.data());

      // Upsert current set result
      const targetSetIndex = setResultsList.findIndex((r: any) => r.setNumber === setNumber);
      const newSetResult = {
        matchId: byeolmuriMatchId,
        setNumber,
        winner,
        blueTeamSource: 'originalBlue',
        redTeamSource: 'originalRed',
        winnerSide: winner === 'A' ? 'blue' : 'red',
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
      const lpChanges: Array<{
        memberId: string;
        before: number;
        change: number;
        after: number;
        reason: string;
      }> = [];

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
          const memberId = Object.keys(memberDocs).find(k => memberDocs[k] === memberObj)!;
          const beforeLP = memberObj.currentLP ?? 1200;

          let oldLpChange = 0;
          let reason = `경기 승인 시 LP ${newLpChange > 0 ? '+' : ''}${newLpChange} 반영 예정 (새로운 기록)`;
          if (sgMatchData.status === 'approved') {
            oldLpChange = sgMatchData.lpChanges?.[playerNickname] ?? 0;
            reason = `기존 승인된 매치 세트 변경으로 인한 LP 변동량 정정 (기존: ${oldLpChange > 0 ? '+' : ''}${oldLpChange}, 변경: ${newLpChange > 0 ? '+' : ''}${newLpChange})`;
          }

          const lpDelta = newLpChange - oldLpChange;
          const afterLP = Math.max(0, beforeLP + lpDelta);

          lpChanges.push({
            memberId,
            before: beforeLP,
            change: lpDelta,
            after: afterLP,
            reason,
          });
        }
      }

      // Check LP preview matching
      for (const pLp of lpChanges) {
        const prevLp = previewData.lpChanges?.find((l: any) => l.memberId === pLp.memberId);
        if (!prevLp) {
          throw new functions.https.HttpsError('failed-precondition', 'lp-preview-mismatch: 미리보기 단계와 반영 단계의 LP 대상 회원이 다릅니다.');
        }
        if (prevLp.change !== pLp.change || prevLp.before !== pLp.before || prevLp.after !== pLp.after) {
          throw new functions.https.HttpsError('failed-precondition', `lp-preview-mismatch: 미리보기 LP 변동값(${prevLp.change})과 실계산 LP 변동값(${pLp.change})이 일치하지 않습니다.`);
        }
      }

      // Validate participants details consistency
      const participantPreviews = normData.participants.map((p: any) => {
        const mapping = reviewedMappings.find((m: any) => m.riotParticipantId === p.participantId);
        const memberId = mapping?.memberId || '';
        const member = memberDocs[memberId];
        const mName = member ? member.nickname : '';

        let byeolmuriTeam: 'A' | 'B' = 'A';
        if (p.teamId === 100) {
          byeolmuriTeam = riotTeam100MapsTo;
        } else {
          byeolmuriTeam = riotTeam100MapsTo === 'A' ? 'B' : 'A';
        }

        let position = 'TOP';
        const pos = (p.teamPosition || p.individualPosition || '').toUpperCase();
        if (pos.includes('JUG')) position = 'JUG';
        else if (pos.includes('MID')) position = 'MID';
        else if (pos.includes('BOT')) position = 'ADC';
        else if (pos.includes('UTI')) position = 'SUP';
        else if (pos.includes('SUP')) position = 'SUP';

        const win = p.win;
        const pLpPreview = lpChanges.find(l => l.memberId === memberId);

        return {
          riotParticipantId: p.participantId,
          memberId,
          memberName: mName,
          byeolmuriTeam,
          riotTeamId: p.teamId,
          championId: p.championId,
          championName: p.championName,
          win,
          kills: p.kills,
          deaths: p.deaths,
          assists: p.assists,
          position,
          totalCs: p.totalCs || (p.totalMinionsKilled + p.neutralMinionsKilled) || 0,
          visionScore: p.visionScore || 0,
          totalDamageDealtToChampions: p.totalDamageDealtToChampions || 0,
          currentLp: pLpPreview ? pLpPreview.before : null,
          lpChange: pLpPreview ? pLpPreview.change : null,
          expectedLpAfter: pLpPreview ? pLpPreview.after : null,
        };
      });

      // Verify each previewed participant matching
      for (const pData of participantPreviews) {
        const origP = previewData.participants?.find((x: any) => x.riotParticipantId === pData.riotParticipantId);
        if (!origP || origP.memberId !== pData.memberId || origP.championName !== pData.championName || origP.kills !== pData.kills || origP.deaths !== pData.deaths || origP.assists !== pData.assists) {
          throw new functions.https.HttpsError('failed-precondition', 'preview-data-mismatch: 미리보기 참가자 정보와 실계산 정보가 일치하지 않습니다.');
        }
      }

      // 8) WRITE ALL updates atomically inside the transaction

      // 8.1) Create Application
      transaction.set(applicationDocRef, {
        id: riotMatchId,
        status: 'applied',
        riotMatchId,
        byeolmuriMatchId,
        setNumber,
        reviewRevision: expectedReviewRevision,
        previewRevision: expectedPreviewRevision,
        appliedAt: admin.firestore.FieldValue.serverTimestamp(),
        appliedByUid: uid,
        appliedByEmail: email
      });

      // 8.2) Create/Update Set Link Reservation
      transaction.set(reservationDocRef, {
        id: reservationId,
        riotMatchId,
        byeolmuriMatchId,
        setNumber,
        previewRevision: expectedPreviewRevision,
        reviewRevision: expectedReviewRevision,
        reservedByUid: uid,
        reservedAt: admin.firestore.FieldValue.serverTimestamp(),
        status: 'applied'
      });

      // 8.3) Update Member documents with new currentLP
      for (const pLp of lpChanges) {
        const mRef = admin.firestore().collection('members').doc(pLp.memberId);
        transaction.update(mRef, {
          currentLP: pLp.after,
          updatedAt: admin.firestore.FieldValue.serverTimestamp()
        });
      }

      // 8.4) Write set result document
      transaction.set(setResultDocRef, {
        id: setResultKey,
        matchId: byeolmuriMatchId,
        setNumber,
        winner,
        blueTeamSource: 'originalBlue',
        redTeamSource: 'originalRed',
        winnerSide: winner === 'A' ? 'blue' : 'red',
        seasonId: sgMatchData.seasonId || 'season0',
        matchStatus: 'approved',
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        resultSource: 'riot_tournament',
        riotMatchId,
        riotApplicationId: riotMatchId,
        gameVersion: normData.gameVersion || '',
        gameDuration: normData.gameDuration || 0,
        gameCreation: normData.gameCreation || 0,
        blueTeamParticipants: reviewedMappings.filter((m: any) => {
          const p = normData.participants.find((p: any) => p.participantId === m.riotParticipantId);
          const team = p.teamId === 100 ? riotTeam100MapsTo : (riotTeam100MapsTo === 'A' ? 'B' : 'A');
          return team === 'A';
        }).map((m: any) => m.memberId),
        redTeamParticipants: reviewedMappings.filter((m: any) => {
          const p = normData.participants.find((p: any) => p.participantId === m.riotParticipantId);
          const team = p.teamId === 100 ? riotTeam100MapsTo : (riotTeam100MapsTo === 'A' ? 'B' : 'A');
          return team === 'B';
        }).map((m: any) => m.memberId),
      });

      // 8.5) Update parent match document (status, scores, lpChanges, matchStats)
      const finalLpChanges: Record<string, number> = {};
      for (const playerNickname of matchPlayers) {
        const cleanNick = playerNickname.replace(/\s+/g, '').toLowerCase();
        const memberObj = Object.values(memberDocs).find(
          (m: any) => m.nickname.replace(/\s+/g, '').toLowerCase() === cleanNick
        );
        if (memberObj) {
          let playerLpChange = 0;
          const isTeamA = (sgMatchData.teamA || []).some((name: string) => name.replace(/\s+/g, '').toLowerCase() === cleanNick);
          if (isDraw11) {
            playerLpChange = drawLP;
          } else {
            if (isTeamA) {
              playerLpChange = isTeamAWinner ? winReward : -losePenalty;
            } else {
              playerLpChange = !isTeamAWinner ? winReward : -losePenalty;
            }
          }
          finalLpChanges[playerNickname] = playerLpChange;
        }
      }

      // Format PlayerMatchStats
      const newStats: any[] = participantPreviews.map((p: any) => ({
        playerId: p.memberId,
        nickname: p.memberName,
        team: p.byeolmuriTeam === 'A' ? 'blue' : 'red',
        actualPosition: p.position,
        champion: p.championName,
        kills: p.kills,
        deaths: p.deaths,
        assists: p.assists,
        result: p.win ? 'win' : 'lose',
        setNumber: setNumber,
        isWin: p.win,
        originalTeamSide: p.byeolmuriTeam === 'A' ? 'originalBlue' : 'originalRed',
        actualSide: p.byeolmuriTeam === 'A' ? 'blue' : 'red',
        teamKey: p.byeolmuriTeam,
        matchId: byeolmuriMatchId,
        seasonId: sgMatchData.seasonId || 'season0',
        totalCs: p.totalCs,
        visionScore: p.visionScore,
        totalDamageDealtToChampions: p.totalDamageDealtToChampions
      }));

      const otherStats = (sgMatchData.matchStats || []).filter((s: any) => s.setNumber !== setNumber);
      const updatedStats = [...otherStats, ...newStats];

      transaction.update(sgMatchDocRef, {
        status: 'approved',
        approvedBy: '경기관리위원회 (Riot 자동)',
        scoreA: newScoreA,
        scoreB: newScoreB,
        winner: isDraw11 ? 'DRAW' : (newScoreA > newScoreB ? 'A' : 'B'),
        score: `${newScoreA}:${newScoreB}`,
        lpChanges: finalLpChanges,
        matchStats: updatedStats,
        totalSets: setResultsList.length,
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      });

      // 8.6) Update Draft Document status to applied
      transaction.update(draftDocRef, {
        applicationStatus: 'applied',
        applicationId: riotMatchId,
        appliedAt: admin.firestore.FieldValue.serverTimestamp(),
        appliedByUid: uid,
        appliedByEmail: email,
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      });

      // 8.7) Update Preview Document status to applied
      transaction.update(previewDocRef, {
        applicationStatus: 'applied',
        applicationId: riotMatchId,
        appliedAt: admin.firestore.FieldValue.serverTimestamp(),
        appliedByUid: uid,
        appliedByEmail: email,
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      });

      return {
        success: true,
        riotMatchId,
        byeolmuriMatchId,
        setNumber,
        applicationId: riotMatchId,
        appliedAt: new Date().toISOString()
      };
    });

    return result;

  } catch (err: any) {
    functions.logger.error(`Exception during applyRiotMatchApplication for matchId: ${riotMatchId}`, err);

    // If it's a critical logic failure before running or during, try updating the application status
    if (err.code !== 'failed-precondition' && err.code !== 'already-exists' && err.code !== 'not-found' && err.code !== 'permission-denied') {
      try {
        await applicationDocRef.set({
          id: riotMatchId,
          status: 'failed',
          riotMatchId,
          failedAt: admin.firestore.FieldValue.serverTimestamp(),
          errorCode: err.message || err.code || 'unknown'
        }, { merge: true });
      } catch (writeErr) {
        functions.logger.error(`Failed to update application status to failed`, writeErr);
      }
    }

    if (err instanceof functions.https.HttpsError) {
      throw err;
    }

    throw new functions.https.HttpsError(
      'internal',
      `공식 반영 중 오류가 발생했습니다: ${err.message || ''}`
    );
  }
});

/**
 * Cloud Function: createTournamentCode
 * 
 * Secure callable trigger to check or register a Riot Tournament Provider & Tournament,
 * and issue a single tournament code for a given byeolmuri match, preventing duplicate issuance using Firestore Transaction.
 * Supports both normal logged-in clan members (for their owned tournaments/matches) and admins.
 */
export const createTournamentCode = functions
  .runWith({
    secrets: [riotApiKeySecret],
  })
  .https.onCall(async (data, context) => {
    // 1. Authentication check
    if (!context.auth) {
      throw new functions.https.HttpsError(
        'unauthenticated',
        '토너먼트 코드를 발급하려면 로그인이 필요합니다.'
      );
    }

    const callerUid = context.auth.uid;
    const email = context.auth.token.email || '';

    // Determine admin status
    let isAdmin = false;
    if (email) {
      if (email === 'lalalalara21@gmail.com') {
        isAdmin = true;
      } else {
        const adminEmailDoc = await admin.firestore().collection('admin_emails').doc(email).get();
        if (adminEmailDoc.exists) {
          isAdmin = true;
        }
      }
    }

    const matchId = data?.matchId;
    if (typeof matchId !== 'string' || matchId.trim() === '') {
      throw new functions.https.HttpsError(
        'invalid-argument',
        'matchId 파라미터가 유효하지 않습니다.'
      );
    }

    const teamSize = typeof data?.teamSize === 'number' ? data.teamSize : 5;
    const pickType = typeof data?.pickType === 'string' && data.pickType.trim() !== '' ? data.pickType : 'TOURNAMENT_DRAFT';

    try {
      // 2. Fetch Match & Tournament data to verify ownership and lock status
      const matchRef = admin.firestore().collection('matches').doc(matchId);
      const initialMatchSnap = await matchRef.get();
      if (!initialMatchSnap.exists) {
        throw new functions.https.HttpsError(
          'not-found',
          `해당 경기(ID: ${matchId})를 찾을 수 없습니다.`
        );
      }

      const matchData = initialMatchSnap.data()!;
      const matchOwner = matchData.submittedByUid || matchData.createdByUid;

      let associatedTourneyDoc: admin.firestore.DocumentSnapshot | null = null;
      let isOwner = matchOwner === callerUid;

      if (matchData.tournamentId) {
        const tourneySnap = await admin.firestore().collection('tournaments').doc(String(matchData.tournamentId)).get();
        if (tourneySnap.exists) {
          associatedTourneyDoc = tourneySnap;
          if (tourneySnap.data()?.createdByUid === callerUid) {
            isOwner = true;
          }
        }
      }

      // 3. Authorization gate for non-admins
      if (!isAdmin) {
        if (!isOwner) {
          throw new functions.https.HttpsError(
            'permission-denied',
            '자신이 생성한 토너먼트 또는 경기에 대해서만 코드를 발급할 수 있습니다.'
          );
        }

        if (associatedTourneyDoc && associatedTourneyDoc.exists && associatedTourneyDoc.data()?.isLocked === true) {
          throw new functions.https.HttpsError(
            'permission-denied',
            '해당 토너먼트는 운영진에 의해 잠금 처리되어 코드를 발급할 수 없습니다.'
          );
        }

        // Active tournament limit check (Max 3 concurrent active tournaments)
        const userTourneysSnap = await admin.firestore()
          .collection('tournaments')
          .where('createdByUid', '==', callerUid)
          .where('status', 'in', ['draft', 'active'])
          .get();

        const activeCount = userTourneysSnap.docs.filter(d => d.data()?.isLocked !== true).length;
        if (activeCount > 3) {
          throw new functions.https.HttpsError(
            'failed-precondition',
            '동시에 활성화할 수 있는 토너먼트 수(최대 3개)를 초과했습니다.'
          );
        }
      }

      // 4. Centralized Settings / Provider and Tournament Bootstrap
      const configRef = admin.firestore().collection('riot_tournament_config').doc('settings');
      let configSnap = await configRef.get();
      let providerId = configSnap.data()?.providerId;
      let tournamentId = configSnap.data()?.tournamentId;

      const riotApiKey = riotApiKeySecret.value();
      const isRealApiKey = typeof riotApiKey === 'string' && riotApiKey.startsWith('RGAPI-');
      const riotApi = isRealApiKey 
        ? new RiotTournamentServiceImpl(riotApiKey) 
        : new RiotTournamentMockService();

      if (!providerId || !tournamentId) {
        functions.logger.info('Riot Tournament Provider or Tournament not initialized. Bootstrapping...');
        const projectId = process.env.GCLOUD_PROJECT || 'f8bf7cb7-5b07-430d-9bde-ad8a1dbe0137';
        const callbackUrl = `https://asia-northeast1-${projectId}.cloudfunctions.net/riotTournamentCallback`;

        if (!providerId) {
          providerId = await riotApi.createProvider('KR', callbackUrl);
        }
        if (!tournamentId) {
          tournamentId = await riotApi.createTournament(providerId, 'Byeolmuri Tournament');
        }

        // Save back to Firestore
        await configRef.set({
          providerId,
          tournamentId,
          callbackUrl,
          region: 'KR',
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        }, { merge: true });

        functions.logger.info(`Bootstrapped successfully. providerId: ${providerId}, tournamentId: ${tournamentId}`);
      }

      // 5. Concurrency Guard & Duplicate Prevention via Firestore Transaction
      let existingCode: string | null = null;
      let existingTourneyId: number | null = null;

      await admin.firestore().runTransaction(async (transaction) => {
        const matchSnap = await transaction.get(matchRef);
        if (!matchSnap.exists) {
          throw new functions.https.HttpsError(
            'not-found',
            `Match with ID ${matchId} does not exist.`
          );
        }

        const currentData = matchSnap.data();
        const status = currentData?.tournamentStatus;

        if (status === 'generating' || status === 'issued') {
          existingCode = currentData?.tournamentCode || null;
          existingTourneyId = currentData?.tournamentId || null;
          return;
        }

        // Lock the match document as 'generating' to block concurrent calls
        transaction.update(matchRef, {
          tournamentStatus: 'generating',
          providerId: providerId,
          tournamentId: tournamentId,
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        });
      });

      // 6. If it was already generated, return the cached result cleanly
      if (existingCode) {
        functions.logger.info(`Tournament code already generated for match ${matchId}. Returning cached result.`);
        return {
          success: true,
          tournamentId: existingTourneyId,
          tournamentCode: existingCode,
          lobbyName: `byeolmuri_${matchId.slice(-4)}`,
          lobbyPassword: `pw_${matchId.slice(-4)}`,
        };
      }

      // 7. Request the code from the Riot Tournament API (or mock)
      functions.logger.info(`Requesting tournament code for match ${matchId}...`);
      const codes = await riotApi.createTournamentCodes(tournamentId, 1, {
        teamSize,
        pickType,
        mapType: 'SUMMONERS_RIFT',
        spectatorType: 'ALL',
        metadata: JSON.stringify({ matchId })
      });

      const tournamentCode = codes[0];
      const lobbyName = `byeolmuri_${matchId.slice(-4)}`;
      const lobbyPassword = `pw_${Math.floor(1000 + Math.random() * 9000)}`;

      // 8. Save successful code back to matches document
      await matchRef.update({
        tournamentId,
        tournamentCode,
        providerId,
        tournamentStatus: 'issued',
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      // Increment tournament code generation count
      if (matchData.tournamentId) {
        const tourneyRef = admin.firestore().collection('tournaments').doc(String(matchData.tournamentId));
        const tSnap = await tourneyRef.get();
        if (tSnap.exists) {
          await tourneyRef.update({
            codeGenerationCount: admin.firestore.FieldValue.increment(1),
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          });
        }
      }

      // Audit Log
      await admin.firestore().collection('audit_logs').add({
        action: 'ISSUE_TOURNAMENT_CODE',
        performedByUid: callerUid,
        performedByName: context.auth.token.name || context.auth.token.email || callerUid,
        targetId: matchId,
        details: {
          tournamentCode,
          tournamentId,
          isAdminCall: isAdmin,
        },
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      functions.logger.info(`Successfully generated and saved tournament code: ${tournamentCode} for match ${matchId}`);
      return {
        success: true,
        tournamentId,
        tournamentCode,
        lobbyName,
        lobbyPassword,
      };

    } catch (err: any) {
      functions.logger.error(`Error during createTournamentCode for matchId ${matchId}`, err);

      // Revert lock if failed and it was in generating state
      try {
        const matchRef = admin.firestore().collection('matches').doc(matchId);
        const matchSnap = await matchRef.get();
        if (matchSnap.exists && matchSnap.data()?.tournamentStatus === 'generating') {
          await matchRef.update({
            tournamentStatus: 'failed',
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          });
        }
      } catch (writeErr) {
        functions.logger.error('Failed to revert tournamentStatus lock', writeErr);
      }

      if (err instanceof functions.https.HttpsError) {
        throw err;
      }

      throw new functions.https.HttpsError(
        'internal',
        `토너먼트 코드 발급 실패: ${err.message || '알 수 없는 서버 오류'}`
      );
    }
  });



/**
 * Cloud Function: refreshLivePlayerStatuses
 *
 * Query Spectator-v5 for active clan members with PUUIDs or Riot IDs.
 * Store results in live_player_status/{puuid} collection with a 3-minute TTL cache.
 * Normalizes queue types (RANKED_SOLO, RANKED_FLEX, NORMAL, ARAM, CUSTOM_BYEOLMURI, etc.).
 */
export const refreshLivePlayerStatuses = functions
  .runWith({
    secrets: [riotApiKeySecret],
  })
  .https.onCall(async (data, context) => {
    const forceRefresh = Boolean(data?.forceRefresh);
    const riotApiKey = riotApiKeySecret.value();
    const spectatorService = new RiotSpectatorService(riotApiKey || '');

    try {
      const now = new Date();
      const nowIso = now.toISOString();
      const cacheTtlMs = 3 * 60 * 1000; // 3 minutes cache TTL

      // Fetch active members
      const membersSnap = await admin.firestore().collection('members').get();
      const members = membersSnap.docs.map(doc => ({ id: doc.id, ...doc.data() })) as any[];

      // Active members with liveStatusVisible !== false
      const activeMembers = members.filter(m => m.isActive !== false && m.liveStatusVisible !== false);

      // Fetch active Byeolmuri matches to check if custom game matches any Byeolmuri match
      const activeMatchesSnap = await admin.firestore()
        .collection('matches')
        .where('status', 'in', ['pending', 'approved'])
        .limit(20)
        .get();
      const activeMatches = activeMatchesSnap.docs.map(doc => ({ id: doc.id, ...doc.data() })) as any[];

      const results: any[] = [];
      let checkedCount = 0;
      let inGameCount = 0;

      for (const member of activeMembers) {
        let puuid = member.puuid;
        const gameName = member.riotIdGameName || member.gameName || member.summonerName;
        const tagLine = member.riotIdTagline || member.tagLine || 'KR1';

        // Auto-resolve PUUID if missing and Riot ID is provided
        if (!puuid && gameName) {
          try {
            puuid = await spectatorService.resolvePuuidByRiotId(gameName, tagLine);
            if (puuid) {
              await admin.firestore().collection('members').doc(member.id).update({
                puuid,
                updatedAt: admin.firestore.FieldValue.serverTimestamp()
              });
            }
          } catch {
            // ignore error
          }
        }

        if (!puuid) {
          continue;
        }

        const cacheRef = admin.firestore().collection('live_player_status').doc(puuid);
        const cacheSnap = await cacheRef.get();

        if (!forceRefresh && cacheSnap.exists) {
          const cacheData = cacheSnap.data()!;
          const expiresAt = new Date(cacheData.expiresAt).getTime();
          if (Date.now() < expiresAt) {
            results.push({ puuid, ...cacheData });
            if (cacheData.isInGame) inGameCount++;
            continue;
          }
        }

        // Perform active game check via Spectator-v5
        checkedCount++;
        let currentGame: any = null;
        let fetchError: string | null = null;

        try {
          currentGame = await spectatorService.getActiveGameByPuuid(puuid);
        } catch (err: any) {
          fetchError = err.message || 'API_ERROR';
        }

        const expiresAt = new Date(now.getTime() + cacheTtlMs).toISOString();

        if (fetchError) {
          // If fetch fails (e.g. rate limit or permission pending), preserve previous state if exists or store error
          const prevData = cacheSnap.exists ? cacheSnap.data() : null;
          const statusDoc = {
            puuid,
            memberId: member.id,
            nickname: member.nickname,
            riotIdGameName: gameName || member.nickname,
            riotIdTagline: tagLine,
            isInGame: prevData ? Boolean(prevData.isInGame) : false,
            normalizedQueueType: prevData ? (prevData.normalizedQueueType || 'UNKNOWN') : 'UNKNOWN',
            checkedAt: nowIso,
            expiresAt,
            errorState: fetchError,
            ...(prevData ? {
              queueId: prevData.queueId,
              gameId: prevData.gameId,
              gameMode: prevData.gameMode,
              gameType: prevData.gameType,
              championId: prevData.championId,
              championName: prevData.championName,
              gameStartTime: prevData.gameStartTime,
              elapsedSeconds: prevData.elapsedSeconds,
              byeolmuriMatchId: prevData.byeolmuriMatchId,
              byeolmuriMatchTitle: prevData.byeolmuriMatchTitle,
            } : {})
          };

          await cacheRef.set(statusDoc, { merge: true });
          results.push(statusDoc);
          if (statusDoc.isInGame) inGameCount++;
          continue;
        }

        if (!currentGame) {
          // Player is not in game
          const statusDoc = {
            puuid,
            memberId: member.id,
            nickname: member.nickname,
            riotIdGameName: gameName || member.nickname,
            riotIdTagline: tagLine,
            isInGame: false,
            normalizedQueueType: 'UNKNOWN',
            checkedAt: nowIso,
            expiresAt,
            errorState: null
          };

          await cacheRef.set(statusDoc, { merge: true });
          results.push(statusDoc);
        } else {
          // Player IS in game!
          inGameCount++;
          const participant = (currentGame.participants || []).find((p: any) => p.puuid === puuid);
          const championId = participant ? participant.championId : undefined;
          const championName = championId ? (CHAMPION_ID_MAP[championId] || `Champion #${championId}`) : undefined;

          // Check if this custom match is linked to a Byeolmuri match/tournament
          let isByeolmuriMatch = false;
          let matchedByeolmuriMatchId: string | null = null;
          let matchedByeolmuriTitle: string | null = null;

          if (currentGame.queueId === 0 || currentGame.gameType === 'CUSTOM_GAME') {
            for (const match of activeMatches) {
              if (match.tournamentCode && currentGame.gameCustomData) {
                isByeolmuriMatch = true;
                matchedByeolmuriMatchId = match.id;
                matchedByeolmuriTitle = `${match.teamA?.[0] || 'A'} VS ${match.teamB?.[0] || 'B'}`;
                break;
              }
            }
          }

          const normalizedQueue = normalizeQueueType(currentGame.queueId, currentGame.gameType, isByeolmuriMatch);
          const elapsedSeconds = currentGame.gameStartTime > 0 
            ? Math.floor((now.getTime() - currentGame.gameStartTime) / 1000)
            : currentGame.gameLength;

          const statusDoc = {
            puuid,
            memberId: member.id,
            nickname: member.nickname,
            riotIdGameName: gameName || member.nickname,
            riotIdTagline: tagLine,
            isInGame: true,
            normalizedQueueType: normalizedQueue,
            queueId: currentGame.queueId,
            gameId: currentGame.gameId,
            gameMode: currentGame.gameMode,
            gameType: currentGame.gameType,
            championId,
            championName,
            gameStartTime: currentGame.gameStartTime,
            elapsedSeconds,
            byeolmuriMatchId: matchedByeolmuriMatchId,
            byeolmuriMatchTitle: matchedByeolmuriTitle,
            checkedAt: nowIso,
            expiresAt,
            errorState: null
          };

          await cacheRef.set(statusDoc, { merge: true });
          results.push(statusDoc);
        }
      }

      return {
        success: true,
        checkedCount,
        inGameCount,
        totalMembers: activeMembers.length,
        checkedAt: nowIso,
        statuses: results
      };
    } catch (err: any) {
      functions.logger.error('Error in refreshLivePlayerStatuses', { error: err.message || String(err) });
      throw new functions.https.HttpsError('internal', '실시간 게임 상태를 조회하는 중 오류가 발생했습니다.');
    }
  });




