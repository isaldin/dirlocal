import { getConfig } from '../config';
import { compactApplied } from '../services/applied';
import { compact } from '../services/journal';
import type { ApiContext, Register } from '../types';

export function registerCompaction({ schedule }: Register, { database, env, logger }: ApiContext): void {
	const { retentionDays } = getConfig(env);

	schedule('0 3 * * *', async () => {
		const deleted = await compact(database, retentionDays);
		const applied = await compactApplied(database, retentionDays);
		logger.info(`[dirlocal] compaction removed ${deleted} journal entries and ${applied} push results older than ${retentionDays} days`);
	});
}
