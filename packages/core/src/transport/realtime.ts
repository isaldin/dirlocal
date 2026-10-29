import type { WebSocketClient } from '@directus/sdk';
import type { RealtimeSource } from '../types.js';

/**
 * Realtime source over an @directus/sdk client with realtime() (Directus needs WEBSOCKETS_ENABLED=true).
 * Subscribes to the primary key only: events are a hint to pull, the data comes from pull under permissions.
 * The SDK reconnects and resubscribes on its own; once it gives up, the subscriptions end and the next start() redoes them.
 */
export function directusRealtime(client: WebSocketClient<any>): RealtimeSource {
	let live = false;
	let generation = 0;
	let unsubscribes: (() => void)[] = [];

	function unsubscribeAll() {
		for (const unsubscribe of unsubscribes) {
			try {
				unsubscribe();
			} catch {
				// Already closed.
			}
		}
		unsubscribes = [];
	}

	return {
		start(collections, onChange) {
			if (live || collections.length === 0) return;
			live = true;
			const current = ++generation;
			unsubscribeAll();

			void (async () => {
				await client.connect();
				let open = collections.length;
				for (const { collection, primaryKey } of collections) {
					const { subscription, unsubscribe } = await client.subscribe(collection, { query: { fields: [primaryKey] } });
					unsubscribes.push(unsubscribe);
					void (async () => {
						for await (const message of subscription) {
							const event = (message as { event?: string }).event;
							if (event === 'create' || event === 'update' || event === 'delete') onChange();
						}
					})()
						.catch(() => undefined)
						.finally(() => {
							if (--open === 0 && generation === current) live = false;
						});
				}
			})().catch(() => {
				if (generation === current) live = false;
			});
		},

		stop() {
			generation++;
			live = false;
			unsubscribeAll();
			client.disconnect();
		},
	};
}
