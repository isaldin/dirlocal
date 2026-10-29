import { type FileCache, type SyncStatus, useCollection, useFileUri, useOffline, usePendingCount, useSyncStatus } from '@dirlocal/expo';
import { useEffect, useMemo, useState } from 'react';
import { FlatList, Image, Pressable, RefreshControl, StyleSheet, Text, View } from 'react-native';

export interface Task {
	id: string;
	title: string;
	status: 'todo' | 'in_progress' | 'done';
	project: string | null;
	photo: string | null;
}

const STATUS_LABEL: Record<SyncStatus, string> = {
	stopped: 'Stopped',
	idle: 'Up to date',
	syncing: 'Syncing…',
	offline: 'Offline — showing local data',
	error: 'Sync error — showing local data',
};

const NEXT_STATUS: Record<Task['status'], Task['status']> = { todo: 'in_progress', in_progress: 'done', done: 'todo' };

interface Props {
	files: FileCache;
	workOffline: boolean;
	onToggleOffline: () => void;
	onNew: () => void;
	onLogout: () => void;
}

export function TasksScreen({ files, workOffline, onToggleOffline, onNew, onLogout }: Props) {
	const offline = useOffline();
	const { status } = useSyncStatus();
	const pending = usePendingCount();
	const tasks = useCollection<Task & Record<string, unknown>>('tasks', { orderBy: [{ field: 'title' }] });
	const projects = useCollection('projects');
	const projectNames = useMemo(() => new Map(projects.data.map((p) => [p['id'], String(p['name'])])), [projects.data]);
	const [refreshing, setRefreshing] = useState(false);
	const [notice, setNotice] = useState<string | null>(null);

	useEffect(() => {
		const offConflict = offline.on('conflict', ({ conflicts }) =>
			setNotice(`Changed on the server meanwhile, kept the server's ${conflicts.map((c) => c.field).join(', ')}`),
		);
		const offRejected = offline.on('rejected', ({ error }) => setNotice(`Not saved: ${error.message}`));
		return () => {
			offConflict();
			offRejected();
		};
	}, [offline]);

	async function refresh() {
		setRefreshing(true);
		// Failures already show in the status line; local data stays on screen.
		await offline.sync().catch(() => undefined);
		setRefreshing(false);
	}

	return (
		<View style={styles.container}>
			<View style={styles.header}>
				<Text style={styles.title}>Tasks</Text>
				<View style={styles.actions}>
					<Pressable testID="new-task" onPress={onNew}>
						<Text style={styles.link}>New</Text>
					</Pressable>
					<Pressable testID="logout" onPress={onLogout}>
						<Text style={styles.link}>Log out</Text>
					</Pressable>
				</View>
			</View>
			<View style={styles.statusRow}>
				<Text testID="sync-status" style={[styles.status, status === 'offline' || status === 'error' ? styles.statusWarn : null]}>
					{STATUS_LABEL[status]} · {tasks.data.length} tasks{pending > 0 ? ` · ${pending} not sent` : ''}
				</Text>
				<Pressable testID="network-toggle" onPress={onToggleOffline}>
					<Text style={styles.link}>{workOffline ? 'Go online' : 'Work offline'}</Text>
				</Pressable>
			</View>
			{notice && (
				<Pressable testID="notice" onPress={() => setNotice(null)}>
					<Text style={styles.notice}>{notice}</Text>
				</Pressable>
			)}
			<FlatList
				data={tasks.data}
				keyExtractor={(task) => task.id}
				refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} />}
				ListEmptyComponent={<Text style={styles.empty}>{tasks.loading ? '' : 'No tasks yet'}</Text>}
				renderItem={({ item }) => (
					<Pressable
						style={styles.row}
						testID={`task-${item.title}`}
						// Tapping cycles the status: an offline edit that goes through the outbox.
						onPress={() => void offline.mutate('tasks', { op: 'update', key: item.id, patch: { status: NEXT_STATUS[item.status] } })}
					>
						{item.photo && <Photo files={files} id={item.photo} />}
						<View style={{ flex: 1 }}>
							<Text style={styles.taskTitle}>{item.title}</Text>
							{item.project && <Text style={styles.project}>{projectNames.get(item.project) ?? '…'}</Text>}
						</View>
						<Text testID={`status-${item.title}`} style={[styles.badge, item.status === 'done' && styles.badgeDone]}>
							{item.status.replace('_', ' ')}
						</Text>
					</Pressable>
				)}
			/>
		</View>
	);
}

function Photo({ files, id }: { files: FileCache; id: string }) {
	const uri = useFileUri(files, id);
	// The label lands in the row's accessibility text, which is how e2e/back-online.yaml finds a loaded photo.
	return uri ? (
		<Image accessibilityLabel="Photo attached" source={{ uri }} style={styles.photo} />
	) : (
		<View style={[styles.photo, styles.photoPlaceholder]} />
	);
}

const styles = StyleSheet.create({
	container: { flex: 1 },
	header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: 16, paddingTop: 8 },
	actions: { flexDirection: 'row', gap: 20 },
	title: { fontSize: 28, fontWeight: '700' },
	link: { color: '#6644ff', fontSize: 16 },
	statusRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16 },
	status: { flexShrink: 1, paddingVertical: 8, color: '#555' },
	statusWarn: { color: '#b26a00' },
	notice: { marginHorizontal: 16, marginBottom: 8, padding: 10, borderRadius: 8, backgroundColor: '#fff4e5', color: '#7a4a00' },
	empty: { textAlign: 'center', color: '#888', marginTop: 32 },
	row: {
		flexDirection: 'row',
		alignItems: 'center',
		gap: 12,
		paddingHorizontal: 16,
		paddingVertical: 14,
		borderBottomWidth: StyleSheet.hairlineWidth,
		borderColor: '#ddd',
	},
	photo: { width: 44, height: 44, borderRadius: 6 },
	photoPlaceholder: { backgroundColor: '#eee' },
	taskTitle: { fontSize: 16 },
	project: { color: '#777', marginTop: 2 },
	badge: { fontSize: 12, color: '#555', backgroundColor: '#eee', borderRadius: 10, paddingHorizontal: 8, paddingVertical: 3, overflow: 'hidden' },
	badgeDone: { backgroundColor: '#d8f3dc', color: '#1b5e20' },
});
