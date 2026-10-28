import { appendChanges, PERMISSIONS_MARKER } from '../services/journal';
import type { ApiContext, Register } from '../types';

const ACCESS_EVENTS = ['permissions', 'policies', 'access', 'roles'].flatMap((scope) =>
	['create', 'update', 'delete'].map((action) => `${scope}.${action}`),
);
// directus_users is updated on every admin page view (last_page), so only access-relevant fields count.
const USER_ACCESS_FIELDS = ['role', 'status', 'policies'];

/**
 * Writes a "$permissions" marker whenever access rules may have changed. Rows that became visible
 * without changing themselves never reach the journal, so clients behind the marker must re-snapshot.
 */
export function registerPermissionMarkers({ action }: Register, { database, logger }: ApiContext): void {
	async function mark(event: string, actor: string | null) {
		try {
			await appendChanges(database, [{ collection: PERMISSIONS_MARKER, key: 'epoch', op: 'u', fields: [event], actor }]);
		} catch (error) {
			logger.error(error, `[dirlocal] failed to write permissions marker for ${event}`);
		}
	}

	for (const event of ACCESS_EVENTS) action(event, (_meta, { accountability }) => mark(event, accountability?.user ?? null));

	action('users.update', ({ payload }, { accountability }) => {
		if (USER_ACCESS_FIELDS.some((field) => field in (payload ?? {}))) return mark('users.update', accountability?.user ?? null);
		return undefined;
	});
}
