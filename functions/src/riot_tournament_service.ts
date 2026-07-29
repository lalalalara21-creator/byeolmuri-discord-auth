import * as functions from 'firebase-functions';

export interface CreateTournamentCodeParams {
  matchId: string;
  teamSize: number;
  pickType: string;
}

export interface RiotTournamentApi {
  createProvider(region: string, callbackUrl: string): Promise<number>;
  createTournament(providerId: number, name: string): Promise<number>;
  createTournamentCodes(tournamentId: number, count: number, params: {
    teamSize: number;
    pickType: string;
    mapType: string;
    spectatorType: string;
    metadata?: string;
  }): Promise<string[]>;
}

/**
 * Real implementation calling Riot Games API using standard fetch.
 */
export class RiotTournamentServiceImpl implements RiotTournamentApi {
  private apiKey: string;
  private baseUrl = 'https://americas.api.riotgames.com';

  constructor(apiKey: string) {
    this.apiKey = apiKey;
  }

  async createProvider(region: string, callbackUrl: string): Promise<number> {
    functions.logger.info(`RiotTournamentService: Registering provider for region ${region} with callback ${callbackUrl}`);
    
    const response = await fetch(`${this.baseUrl}/lol/tournament/v5/providers`, {
      method: 'POST',
      headers: {
        'X-Riot-Token': this.apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        region: region.toUpperCase(),
        url: callbackUrl,
      }),
    });

    if (!response.ok) {
      const errText = await response.text();
      functions.logger.error(`RiotTournamentService: Provider registration failed with status ${response.status}`, { error: errText });
      throw new Error(`Riot API Provider Registration Failed: ${response.status} - ${errText}`);
    }

    const providerId = Number(await response.text());
    if (isNaN(providerId)) {
      throw new Error('Riot API returned an invalid provider ID format');
    }

    functions.logger.info(`RiotTournamentService: Provider registered successfully. Provider ID: ${providerId}`);
    return providerId;
  }

  async createTournament(providerId: number, name: string): Promise<number> {
    functions.logger.info(`RiotTournamentService: Registering tournament "${name}" with provider ${providerId}`);
    
    const response = await fetch(`${this.baseUrl}/lol/tournament/v5/tournaments`, {
      method: 'POST',
      headers: {
        'X-Riot-Token': this.apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        name: name,
        providerId: providerId,
      }),
    });

    if (!response.ok) {
      const errText = await response.text();
      functions.logger.error(`RiotTournamentService: Tournament registration failed with status ${response.status}`, { error: errText });
      throw new Error(`Riot API Tournament Registration Failed: ${response.status} - ${errText}`);
    }

    const tournamentId = Number(await response.text());
    if (isNaN(tournamentId)) {
      throw new Error('Riot API returned an invalid tournament ID format');
    }

    functions.logger.info(`RiotTournamentService: Tournament registered successfully. Tournament ID: ${tournamentId}`);
    return tournamentId;
  }

  async createTournamentCodes(tournamentId: number, count: number, params: {
    teamSize: number;
    pickType: string;
    mapType: string;
    spectatorType: string;
    metadata?: string;
  }): Promise<string[]> {
    functions.logger.info(`RiotTournamentService: Generating ${count} tournament codes for tournament ${tournamentId}`);
    
    const response = await fetch(`${this.baseUrl}/lol/tournament/v5/codes?count=${count}&tournamentId=${tournamentId}`, {
      method: 'POST',
      headers: {
        'X-Riot-Token': this.apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        teamSize: params.teamSize,
        pickType: params.pickType,
        mapType: params.mapType,
        spectatorType: params.spectatorType,
        allowedSummonerIds: [],
        metadata: params.metadata,
      }),
    });

    if (!response.ok) {
      const errText = await response.text();
      functions.logger.error(`RiotTournamentService: Tournament code generation failed with status ${response.status}`, { error: errText });
      throw new Error(`Riot API Code Generation Failed: ${response.status} - ${errText}`);
    }

    const codes = (await response.json()) as string[];
    if (!Array.isArray(codes) || codes.length === 0) {
      throw new Error('Riot API did not return an array of tournament codes');
    }

    functions.logger.info(`RiotTournamentService: Generated ${codes.length} tournament codes successfully.`);
    return codes;
  }
}

/**
 * Mock implementation to bypass Riot API calls in sandbox/development environments when real key is not set.
 */
export class RiotTournamentMockService implements RiotTournamentApi {
  async createProvider(region: string, callbackUrl: string): Promise<number> {
    functions.logger.info(`RiotTournamentMockService: Mock registering provider for ${region} / ${callbackUrl}`);
    // Simulate a brief delay
    await new Promise((resolve) => setTimeout(resolve, 300));
    const mockProviderId = 9988;
    functions.logger.info(`RiotTournamentMockService: Mock provider registered. Provider ID: ${mockProviderId}`);
    return mockProviderId;
  }

  async createTournament(providerId: number, name: string): Promise<number> {
    functions.logger.info(`RiotTournamentMockService: Mock registering tournament "${name}" for provider ${providerId}`);
    await new Promise((resolve) => setTimeout(resolve, 300));
    const mockTournamentId = 7766;
    functions.logger.info(`RiotTournamentMockService: Mock tournament registered. Tournament ID: ${mockTournamentId}`);
    return mockTournamentId;
  }

  async createTournamentCodes(tournamentId: number, count: number, params: {
    teamSize: number;
    pickType: string;
    mapType: string;
    spectatorType: string;
    metadata?: string;
  }): Promise<string[]> {
    functions.logger.info(`RiotTournamentMockService: Mock generating ${count} codes for tournament ${tournamentId}`);
    await new Promise((resolve) => setTimeout(resolve, 300));
    
    const codes: string[] = [];
    for (let i = 0; i < count; i++) {
      const randomSegment = Math.floor(100000 + Math.random() * 900000);
      codes.push(`MOCK-KR-${tournamentId}-${randomSegment}`);
    }
    
    functions.logger.info(`RiotTournamentMockService: Generated mock codes successfully.`);
    return codes;
  }
}
