import { type SyncStatus, useCollection, useOffline, useSyncStatus } from '@dirlocal/expo';
import { useMemo, useState } from 'react';
import { FlatList, Pressable, RefreshControl, StyleSheet, Text, View } from 'react-native';

interface Task {
	id: string;
	title: string;
	status: 'todo' | 'in_progress' | 'done';
	project: string | null;
}

const STATUS_LABEL: Record<SyncStatus, string> = {
	stopped: 'Stopped',
	idle: 'Up to date',
	syncing: 'Syncing…',
	offline: 'Offline — showing local data',
	error: 'Sync error — showing local data',
};

export function TasksScreen({ onLogout }: { onLogout: () => void }) {
	const offline = useOffline();
	const { status } = useSyncStatus();
	const tasks = useCollection<Task & Record<string, unknown>>('tasks', { orderBy: [{ field: 'title' }] });
	const projects = useCollection('projects');
	const projectNames = useMemo(() => new Map(projects.data.map((p) => [p['id'], String(p['name'])])), [projects.data]);
	const [refreshing, setRefreshing] = useState(false);

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
				<Pressable testID="logout" onPress={onLogout}>
					<Text style={styles.link}>Log out</Text>
				</Pressable>
			</View>
			<Text testID="sync-status" style={[styles.status, status === 'offline' || status === 'error' ? styles.statusWarn : null]}>
				{STATUS_LABEL[status]} · {tasks.data.length} tasks
			</Text>
			<FlatList
				data={tasks.data}
				keyExtractor={(task) => task.id}
				refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} />}
				ListEmptyComponent={<Text style={styles.empty}>{tasks.loading ? '' : 'No tasks yet'}</Text>}
				renderItem={({ item }) => (
					<View style={styles.row} testID={`task-${item.title}`}>
						<View style={{ flex: 1 }}>
							<Text style={styles.taskTitle}>{item.title}</Text>
							{item.project && <Text style={styles.project}>{projectNames.get(item.project) ?? '…'}</Text>}
						</View>
						<Text style={[styles.badge, item.status === 'done' && styles.badgeDone]}>{item.status.replace('_', ' ')}</Text>
					</View>
				)}
			/>
		</View>
	);
}

const styles = StyleSheet.create({
	container: { flex: 1 },
	header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: 16, paddingTop: 8 },
	title: { fontSize: 28, fontWeight: '700' },
	link: { color: '#6644ff', fontSize: 16 },
	status: { paddingHorizontal: 16, paddingVertical: 8, color: '#555' },
	statusWarn: { color: '#b26a00' },
	empty: { textAlign: 'center', color: '#888', marginTop: 32 },
	row: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 14, borderBottomWidth: StyleSheet.hairlineWidth, borderColor: '#ddd' },
	taskTitle: { fontSize: 16 },
	project: { color: '#777', marginTop: 2 },
	badge: { fontSize: 12, color: '#555', backgroundColor: '#eee', borderRadius: 10, paddingHorizontal: 8, paddingVertical: 3, overflow: 'hidden' },
	badgeDone: { backgroundColor: '#d8f3dc', color: '#1b5e20' },
});
