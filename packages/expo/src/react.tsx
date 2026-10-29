import type { LocalQuery, Offline, Row, SyncStatus } from '@dirlocal/core';
import { createContext, type ReactNode, useContext, useEffect, useState } from 'react';
import type { FileCache } from './files.js';

const OfflineContext = createContext<Offline | null>(null);

export function OfflineProvider({ offline, children }: { offline: Offline; children: ReactNode }) {
	return <OfflineContext.Provider value={offline}>{children}</OfflineContext.Provider>;
}

export function useOffline(): Offline {
	const offline = useContext(OfflineContext);
	if (!offline) throw new Error('useOffline: wrap the app in <OfflineProvider offline={…}>');
	return offline;
}

export interface CollectionState<T> {
	data: T[];
	/** True until the first local query resolves. Local only: it says nothing about the network. */
	loading: boolean;
	error: unknown;
}

/** Rows from the local database; re-queries when sync changes this collection. */
export function useCollection<T extends Row = Row>(collection: string, query?: LocalQuery): CollectionState<T> {
	const offline = useOffline();
	// Callers usually pass an inline object; compare by value so each render doesn't re-query.
	const queryKey = JSON.stringify(query ?? {});
	const [state, setState] = useState<CollectionState<T>>({ data: [], loading: true, error: undefined });

	useEffect(() => {
		let active = true;
		let latest = 0;
		const load = async () => {
			const request = ++latest;
			try {
				const data = (await offline.query(collection, JSON.parse(queryKey) as LocalQuery)) as T[];
				if (active && request === latest) setState({ data, loading: false, error: undefined });
			} catch (error) {
				if (active && request === latest) setState((previous) => ({ ...previous, loading: false, error }));
			}
		};

		void load();
		const unsubscribe = offline.on('change', ({ collections }) => {
			if (collections.includes(collection)) void load();
		});
		return () => {
			active = false;
			unsubscribe();
		};
	}, [offline, collection, queryKey]);

	return state;
}

export function useSyncStatus(): { status: SyncStatus; error?: unknown } {
	const offline = useOffline();
	const [state, setState] = useState<{ status: SyncStatus; error?: unknown }>(() => ({ status: offline.getStatus() }));

	useEffect(() => {
		setState({ status: offline.getStatus() });
		return offline.on('status', setState);
	}, [offline]);

	return state;
}

/** Number of local changes not yet accepted by the server. */
export function usePendingCount(): number {
	const offline = useOffline();
	const [pending, setPending] = useState(0);

	useEffect(() => {
		let active = true;
		void offline.pending().then((mutations) => active && setPending(mutations.length));
		const unsubscribe = offline.on('outbox', (event) => setPending(event.pending));
		return () => {
			active = false;
			unsubscribe();
		};
	}, [offline]);

	return pending;
}

/**
 * Local URI of a file for <Image>: null while loading, or when it can't be fetched (offline and not cached).
 * Tries again after the next successful sync.
 */
export function useFileUri(files: FileCache, id: string | null | undefined): string | null {
	const offline = useOffline();
	const [uri, setUri] = useState<string | null>(null);

	useEffect(() => {
		let active = true;
		let found: string | null = null;
		setUri(null);
		if (!id) return;
		const load = () =>
			void files.uri(id).then((next) => {
				found = next;
				if (active) setUri(next);
			});
		load();
		const unsubscribe = offline.on('status', ({ status }) => {
			if (status === 'idle' && !found) load();
		});
		return () => {
			active = false;
			unsubscribe();
		};
	}, [offline, files, id]);

	return uri;
}
