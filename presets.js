// Habit presets: icon + the phrase used in messages ("I'm not {activity} today"). Nothing to type.
export const PRESETS = [
  { key: 'walk', label: 'Walk', icon: 'walk-outline', activity: 'going for a walk' },
  { key: 'study', label: 'Study', icon: 'book-outline', activity: 'studying' },
  { key: 'work', label: 'Work', icon: 'briefcase-outline', activity: 'working' },
  { key: 'exercise', label: 'Exercise', icon: 'barbell-outline', activity: 'exercising' },
  { key: 'read', label: 'Read', icon: 'library-outline', activity: 'reading' },
  { key: 'meditate', label: 'Meditate', icon: 'leaf-outline', activity: 'meditating' },
  { key: 'water', label: 'Water', icon: 'water-outline', activity: 'drinking water' },
  { key: 'custom', label: 'Custom', icon: 'create-outline', activity: null },
];

export const presetFor = (habit) => {
  const a = (habit?.activity || '').trim().toLowerCase();
  return PRESETS.find((p) => p.activity && p.activity === a) || null;
};
export const iconFor = (habit) => presetFor(habit)?.icon || 'checkmark-circle-outline';
