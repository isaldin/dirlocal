import { createOffline, memoryStorage, type Offline, type PullResponse, type Row, type Transport } from '@dirlocal/core';
import { act, render, renderHook, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it } from 'vitest';
import { OfflineProvider, useCollection, useOffline, usePendingCount, useSyncStatus } from '../src/react.js';

/** Minimal server: whatever is in `rows` is snapshotted; `next` is returned by the following pull. */
function server(rows: Row[]) {
	let next: PullResponse | null = null;
	const transport: Transport = {
		snapshotKeys: async () => ({ cursor: 1, primary_key: 'id', keys: rows.map((r) => String(r['id'])) }),
		snapshotItems: async (_c, keys) => rows.filter((r) => keys.includes(String(r['id']))),
		pull: async ({ cursor }) => {
			const response = next ?? { changes: [], next_cursor: cursor, has_more: false, inactive: [] };
			next = null;
			return response;
		},
		push: async (mutations) => mutations.map((m) => ({ mutation_id: m.mutation_id, status: 'applied' as const })),
	};
	return { transport, push: (response: PullResponse) => (next = response) };
}

function setup(rows: Row[]) {
	const { transport, push } = server(rows);
	const offline = createOffline({ transport, storage: memoryStorage(), collections: ['tasks'] });
	const wrapper = ({ children }: { children: ReactNode }) => <OfflineProvider offline={offline}>{children}</OfflineProvider>;
	return { offline, wrapper, push };
}

const tasks = [
	{ id: 't1', title: 'Tile the floor', status: 'todo' },
	{ id: 't2', title: 'Fit the shower', status: 'done' },
];

describe('useCollection', () => {
	it('loads local rows and re-queries when sync changes the collection', async () => {
		const { offline, wrapper, push } = setup(tasks);
		const { result } = renderHook(() => useCollection('tasks', { orderBy: [{ field: 'title' }] }), { wrapper });

		await waitFor(() => expect(result.current.loading).toBe(false));
		expect(result.current.data).toEqual([]);

		await act(() => offline.sync());
		await waitFor(() => expect(result.current.data.map((t) => t['id'])).toEqual(['t2', 't1']));

		push({
			changes: [{ collection: 'tasks', key: 't1', op: 'delete', version: 2 }],
			next_cursor: 2,
			has_more: false,
			inactive: [],
		});
		await act(() => offline.sync());
		await waitFor(() => expect(result.current.data.map((t) => t['id'])).toEqual(['t2']));
	});

	it('applies the where filter and does not re-query for an equal inline query', async () => {
		const { offline, wrapper } = setup(tasks);
		await offline.sync();
		let queries = 0;
		const query = offline.query.bind(offline);
		(offline as { query: Offline['query'] }).query = (...args) => {
			queries++;
			return query(...args);
		};

		const { result, rerender } = renderHook(() => useCollection('tasks', { where: { status: 'done' } }), { wrapper });
		await waitFor(() => expect(result.current.data.map((t) => t['id'])).toEqual(['t2']));
		rerender();
		rerender();
		expect(queries).toBe(1);
	});
});

describe('useSyncStatus', () => {
	it('follows the engine status', async () => {
		const { offline, wrapper } = setup(tasks);
		const { result } = renderHook(() => useSyncStatus(), { wrapper });
		expect(result.current.status).toBe('stopped');

		await act(() => offline.sync());
		expect(result.current.status).toBe('idle');
	});
});

describe('useOffline', () => {
	it('explains a missing provider', () => {
		function Probe() {
			useOffline();
			return null;
		}
		expect(() => render(<Probe />)).toThrow(/OfflineProvider/);
	});

	it('renders with the provider', async () => {
		const { wrapper } = setup(tasks);
		function Count() {
			const { data, loading } = useCollection('tasks');
			return <span>{loading ? 'loading' : `${data.length} rows`}</span>;
		}
		render(<Count />, { wrapper });
		expect(await screen.findByText('0 rows')).toBeDefined();
	});
});

describe('usePendingCount', () => {
	it('counts unsent mutations and drops to zero after sync', async () => {
		const { offline, wrapper } = setup(tasks);
		await offline.sync();
		const { result } = renderHook(() => usePendingCount(), { wrapper });

		await act(() => offline.mutate('tasks', { op: 'update', key: 't1', patch: { status: 'done' } }).then(() => undefined));
		expect(result.current).toBe(1);

		await act(() => offline.sync());
		expect(result.current).toBe(0);
	});
});
