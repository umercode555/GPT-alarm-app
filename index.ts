import { requireNativeModule } from 'expo';
import { Platform } from 'react-native';

type Native = {
  setSchedule(json: string): boolean;
  stop(habitId: string): boolean;
  snooze(habitId: string, name: string, atMs: number, repeatSec: number, snoozeMin: number): boolean;
  getPending(): string;
  ackPending(idsJson: string): boolean;
  setSound(uri: string, name: string): Promise<string>;
  clearSound(): boolean;
  getSoundName(): string;
  testAlarm(): boolean;
  status(): string;
  openSettings(kind: string): boolean;
};

let native: Native | null = null;
try {
  if (Platform.OS === 'android') native = requireNativeModule('NudgeAlarm') as Native;
} catch {
  native = null;
}
export default native;
