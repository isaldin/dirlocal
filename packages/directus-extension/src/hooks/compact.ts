import { getConfig } from '../config';
import { compact } from '../services/journal';
import type { ApiContext, Register } from '../types';

export function registerCompaction({ schedule }: Register, { database, env, logger }: ApiContext): void {
	const { retentionDays } = getConfig(env);

	schedule('0 3 * * *', async () => {
		const deleted = await compact(database, retentionDays);
		logger.info(`[dirlocal] compaction removed ${deleted} journal entries older than ${retentionDays} days`);
	});
}
