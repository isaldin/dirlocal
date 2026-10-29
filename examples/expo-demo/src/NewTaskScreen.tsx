import { type FileCache, useOffline } from '@dirlocal/expo';
import * as ImagePicker from 'expo-image-picker';
import { useState } from 'react';
import { Image, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

/** Creates a task, optionally with a photo — works the same with or without a network. */
export function NewTaskScreen({ files, onDone }: { files: FileCache; onDone: () => void }) {
	const offline = useOffline();
	const [title, setTitle] = useState('');
	const [photo, setPhoto] = useState<ImagePicker.ImagePickerAsset | null>(null);
	const [saving, setSaving] = useState(false);

	async function pickPhoto() {
		const result = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], quality: 0.6 });
		if (!result.canceled) setPhoto(result.assets[0] ?? null);
	}

	async function save() {
		if (!title.trim()) return;
		setSaving(true);
		// The picker's file is temporary: the cache copies it and queues the upload ahead of the task.
		const photoId = photo
			? // No name: the picker's fileName can say .heic for data it already converted to JPEG; the cache uses the file's own name.
				await files.add({ uri: photo.uri, type: photo.mimeType ?? 'image/jpeg' })
			: null;
		await offline.mutate('tasks', { op: 'create', data: { title: title.trim(), status: 'todo', photo: photoId } });
		onDone();
	}

	return (
		<View style={styles.container}>
			<Text style={styles.title}>New task</Text>
			<TextInput
				testID="new-title"
				style={styles.input}
				placeholder="Title"
				value={title}
				onChangeText={setTitle}
				autoFocus
				returnKeyType="done"
			/>
			{photo && <Image source={{ uri: photo.uri }} style={styles.preview} testID="photo-preview" />}
			<Pressable testID="add-photo" style={styles.secondary} onPress={pickPhoto}>
				<Text style={styles.secondaryText}>{photo ? 'Change photo' : 'Add photo'}</Text>
			</Pressable>
			<Pressable testID="save-task" style={[styles.button, (!title.trim() || saving) && styles.disabled]} onPress={save} disabled={saving}>
				<Text style={styles.buttonText}>Save</Text>
			</Pressable>
			<Pressable testID="cancel" onPress={onDone}>
				<Text style={styles.link}>Cancel</Text>
			</Pressable>
		</View>
	);
}

const styles = StyleSheet.create({
	container: { flex: 1, padding: 16, gap: 14 },
	title: { fontSize: 28, fontWeight: '700' },
	input: { borderWidth: 1, borderColor: '#ccc', borderRadius: 8, padding: 12, fontSize: 16 },
	preview: { width: '100%', height: 200, borderRadius: 8 },
	secondary: { padding: 12, borderRadius: 8, borderWidth: 1, borderColor: '#6644ff', alignItems: 'center' },
	secondaryText: { color: '#6644ff', fontSize: 16 },
	button: { backgroundColor: '#6644ff', padding: 14, borderRadius: 8, alignItems: 'center' },
	buttonText: { color: 'white', fontSize: 16, fontWeight: '600' },
	disabled: { opacity: 0.5 },
	link: { color: '#6644ff', fontSize: 16, textAlign: 'center' },
});
