import { validateSongShape, migrateSong } from './song.js';

export const emptyOrganization = () => ({ favorites: [], folders: [], assignments: {}, tags: {}, setlists: [], trash: [] });

export function validateOrganization(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const str = (v) => typeof v === 'string' && v.length <= 500;
  const strings = (v) => Array.isArray(v) && v.length <= 3000 && v.every(str);
  return strings(value.favorites) && Array.isArray(value.folders) && value.folders.length <= 200 && value.folders.every((f) => f && str(f.id) && str(f.name))
    && value.assignments && typeof value.assignments === 'object' && !Array.isArray(value.assignments) && Object.values(value.assignments).every(str)
    && value.tags && typeof value.tags === 'object' && !Array.isArray(value.tags) && Object.values(value.tags).every(strings)
    && Array.isArray(value.setlists) && value.setlists.length <= 200 && value.setlists.every((s) => s && str(s.id) && str(s.name) && strings(s.songIds))
    && Array.isArray(value.trash) && value.trash.length <= 1000 && value.trash.every((item) => item && str(item.deletedAt) && validateSongShape(migrateSong(item.song)).ok);
}
