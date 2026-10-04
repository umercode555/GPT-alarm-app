import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator, Alert, AppState, KeyboardAvoidingView, Modal, Platform, RefreshControl,
  ScrollView, StyleSheet, Switch, Text, TextInput, ToastAndroid, TouchableOpacity, View,
} from 'react-native';
import { StatusBar } from 'expo-status-bar';
import AsyncStorage from '@react-native-async-storage/async-storage';
import Ionicons from '@expo/vector-icons/Ionicons';
import * as DocumentPicker from 'expo-document-picker';
import { DateTimePickerAndroid } from '@react-native-community/datetimepicker';
import { initClient, db } from './src/supa';
import {
  deleteHabit, flushOutbox, getCachedHabits, getOutbox, getSnoozes, loadDecisions, loadHabits, retryNow,
  saveHabit, setSnoozes, submitDecision,
} from './src/data';
import * as Alarm from './src/alarm';
import { PRESETS, iconFor, presetFor } from './src/presets';
import { buildMessage, dayKey, fmtHHMM, formatDateLong, formatStamp, timeOnly, uuid } from './src/time';

const C = {
  bg: '#F5F5FB', card: '#FFFFFF', ink: '#15152B', sub: '#6E6E8A', line: '#E8E8F3',
  primary: '#5B5BD6', primaryDark: '#4343B8', primarySoft: '#ECECFC',
  green: '#16A068', greenSoft: '#E1F6EC', red: '#DB4B4B', redSoft: '#FCE9E9', amber: '#C77D0A', amberSoft: '#FFF2D9',
};
const EMPTY = { name: 'Walk', activity: 'going for a walk', remind_time: '22:00', repeat_seconds: 300, snooze_minutes: 15, chat_url: '', enabled: true };
const toast = (m) => { if (Platform.OS === 'android') ToastAndroid.show(m, ToastAndroid.LONG); };
const Icon = ({ name, size = 20, color = C.ink }) => <Ionicons name={name} size={size} color={color} />;

export default function App() {
  const [phase, setPhase] = useState('boot'); // boot | login | main
  const [cfg, setCfg] = useState({ url: '', key: '', email: '' });
  const [tab, setTab] = useState('today');
  const [habits, setHabits] = useState([]);
  const [decisions, setDecisions] = useState([]);
  const [snoozes, setSn] = useState({});
  const [offline, setOffline] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [editing, setEditing] = useState(null);
  const [tick, setTick] = useState(0);
  const lastPress = useRef({});
  const started = useRef(false);
  const seen = useRef({});

  const refresh = useCallback(async () => {
    try { await flushOutbox(); } catch {}
    const [h, d, s] = await Promise.all([loadHabits(), loadDecisions(), getSnoozes()]);
    setHabits(h.habits); setDecisions(d.decisions); setSn(s); setOffline(h.offline || d.offline);
    try { Alarm.rescheduleAll(h.habits, d.decisions, s); } catch {}
    return h.habits;
  }, []);

  // light refresh (no re-scheduling): announces when a message was delivered to ChatGPT
  const refreshDecisions = useCallback(async () => {
    const d = await loadDecisions();
    setDecisions(d.decisions); setOffline(d.offline);
    for (const x of d.decisions) {
      if (seen.current[x.id] && seen.current[x.id] !== 'sent' && x.status === 'sent') toast(`Delivered to ChatGPT: ${x.habit_name}`);
      seen.current[x.id] = x.status;
    }
  }, []);

  // decisions made on the ALARM SCREEN / notification buttons are stored natively; upload them here
  const flushNative = useCallback(async () => {
    const items = Alarm.getPending();
    if (!items.length) return false;
    const list = await getCachedHabits();
    const sn = await getSnoozes();
    const ack = [];
    for (const it of items) {
      const habit = list.find((h) => h.id === it.habitId);
      if (habit) {
        const when = new Date(it.ts);
        await submitDecision({
          id: it.id, habit_id: habit.id, habit_name: habit.name, decision: it.decision,
          message: buildMessage(habit, it.decision, when), chat_url: habit.chat_url, decided_at: when.toISOString(),
        });
        if (it.decision === 'snoozed') sn[habit.id] = it.ts + (habit.snooze_minutes || 15) * 60000; else delete sn[habit.id];
        toast(it.decision === 'snoozed' ? `Snoozed ${habit.name}` : 'Saved. Your laptop will send it to ChatGPT.');
      }
      ack.push(it.id);
    }
    await setSnoozes(sn);
    Alarm.ackPending(ack);
    return true;
  }, []);

  const decide = useCallback(async (habit, decision) => {
    const k = habit.id + decision;
    if (Date.now() - (lastPress.current[k] || 0) < 3000) return;
    lastPress.current[k] = Date.now();
    const now = new Date();
    const sent = await submitDecision({
      id: uuid(), habit_id: habit.id, habit_name: habit.name, decision,
      message: buildMessage(habit, decision, now), chat_url: habit.chat_url, decided_at: now.toISOString(),
    });
    Alarm.stop(habit.id);
    const sn = await getSnoozes();
    if (decision === 'snoozed') {
      const at = Date.now() + (habit.snooze_minutes || 15) * 60000;
      sn[habit.id] = at; Alarm.snooze(habit, at);
    } else delete sn[habit.id];
    await setSnoozes(sn);
    toast(!sent ? 'Saved on your phone. It will upload when you are online.'
      : decision === 'snoozed' ? `Snoozed ${habit.snooze_minutes || 15} min` : 'Saved. Your laptop will send it to ChatGPT.');
    await refresh();
  }, [refresh]);

  // ---- boot ----
  useEffect(() => {
    (async () => {
      const raw = await AsyncStorage.getItem('nudge.cfg');
      if (!raw) return setPhase('login');
      const c = JSON.parse(raw);
      setCfg(c);
      const client = initClient(c.url, c.key);
      const { data } = await client.auth.getSession();
      setPhase(data.session ? 'main' : 'login');
    })();
  }, []);

  useEffect(() => {
    if (phase !== 'main' || started.current) return;
    started.current = true;
    (async () => {
      await Alarm.askNotificationPermission();
      await refresh();
      if (await flushNative()) await refresh();
    })();
    const app = AppState.addEventListener('change', async (st) => {
      if (st === 'active') {
        db()?.auth.startAutoRefresh();
        await refresh();
        if (await flushNative()) await refresh();
        setTick((t) => t + 1);
      } else db()?.auth.stopAutoRefresh();
    });
    const timer = setInterval(() => { setTick((t) => t + 1); refreshDecisions(); }, 20000);
    return () => { app.remove(); clearInterval(timer); started.current = false; };
  }, [phase, refresh, flushNative, refreshDecisions]);

  const onRefresh = async () => { setRefreshing(true); await refresh(); setRefreshing(false); };

  if (phase === 'boot') return <View style={[s.fill, s.center]}><ActivityIndicator size="large" color={C.primary} /></View>;
  if (phase === 'login') return <Login cfg={cfg} onDone={(c) => { setCfg(c); started.current = false; setPhase('main'); }} />;

  const TABS = [['today', 'today', 'Today'], ['habits', 'list', 'Habits'], ['history', 'time', 'History'], ['settings', 'settings', 'Settings']];
  return (
    <View style={s.fill}>
      <StatusBar style="dark" />
      <View style={s.header}>
        <View style={s.logo}><Icon name="alarm" size={20} color="#fff" /></View>
        <Text style={s.title}>Nudge</Text>
        {offline && <View style={s.offPill}><Icon name="cloud-offline-outline" size={13} color={C.red} /><Text style={s.offTxt}>offline</Text></View>}
      </View>
      <ScrollView
        style={s.fill} contentContainerStyle={{ padding: 16, paddingBottom: 130 }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} colors={[C.primary]} />}
        keyboardShouldPersistTaps="handled"
      >
        {tab === 'today' && <Today habits={habits} decisions={decisions} snoozes={snoozes} onDecide={decide} tick={tick} goHabits={() => setTab('habits')} />}
        {tab === 'habits' && <Habits habits={habits} onEdit={setEditing} />}
        {tab === 'history' && <History decisions={decisions} habits={habits} onRetry={async (id) => { try { await retryNow(id); onRefresh(); } catch (e) { Alert.alert('Error', e.message); } }} />}
        {tab === 'settings' && <Settings cfg={cfg} offline={offline} onRefresh={onRefresh}
          onSignOut={async () => { await db().auth.signOut(); Alarm.rescheduleAll([], [], {}); started.current = false; setPhase('login'); }} />}
      </ScrollView>
      {tab === 'habits' && (
        <TouchableOpacity style={s.fab} activeOpacity={0.85} onPress={() => setEditing({ ...EMPTY })}>
          <Icon name="add" size={22} color="#fff" /><Text style={s.fabTxt}>New habit</Text>
        </TouchableOpacity>
      )}
      <View style={s.tabs}>
        {TABS.map(([k, ic, l]) => (
          <TouchableOpacity key={k} style={s.tab} onPress={() => setTab(k)} activeOpacity={0.7}>
            <Icon name={tab === k ? ic : `${ic}-outline`} size={23} color={tab === k ? C.primary : '#9A9AB5'} />
            <Text style={[s.tabTxt, tab === k && { color: C.primary, fontWeight: '700' }]}>{l}</Text>
          </TouchableOpacity>
        ))}
      </View>
      {editing && <HabitEditor habit={editing} onClose={() => setEditing(null)} onSaved={async () => { setEditing(null); await refresh(); }} />}
    </View>
  );
}

// ------------------------------------------------------------------ Login
function Login({ cfg, onDone }) {
  const [url, setUrl] = useState(cfg.url || '');
  const [key, setKey] = useState(cfg.key || '');
  const [email, setEmail] = useState(cfg.email || '');
  const [pw, setPw] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const go = async () => {
    setErr('');
    if (!/^https:\/\/.+\.supabase\.co/i.test(url.trim())) return setErr('Project URL should look like https://abcdxyz.supabase.co');
    if (key.trim().length < 20 || !email || !pw) return setErr('Fill in every field.');
    setBusy(true);
    try {
      const client = initClient(url, key);
      const { error } = await client.auth.signInWithPassword({ email: email.trim(), password: pw });
      if (error) throw error;
      const c = { url: url.trim(), key: key.trim(), email: email.trim() };
      await AsyncStorage.setItem('nudge.cfg', JSON.stringify(c));
      onDone(c);
    } catch (e) { setErr(e.message || 'Could not sign in'); }
    setBusy(false);
  };

  return (
    <KeyboardAvoidingView style={s.fill} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <StatusBar style="dark" />
      <ScrollView contentContainerStyle={{ padding: 24, paddingTop: 80 }} keyboardShouldPersistTaps="handled">
        <View style={[s.logo, { width: 64, height: 64, borderRadius: 20 }]}><Icon name="alarm" size={32} color="#fff" /></View>
        <Text style={[s.title, { fontSize: 32, marginTop: 16 }]}>Nudge</Text>
        <Text style={{ color: C.sub, marginBottom: 24, marginTop: 4 }}>Connect to your Supabase project (one time).</Text>
        <Field label="Supabase Project URL" value={url} onChangeText={setUrl} placeholder="https://xxxx.supabase.co" autoCapitalize="none" />
        <Field label="Supabase publishable key" value={key} onChangeText={setKey} placeholder="sb_publishable_…" autoCapitalize="none" />
        <Field label="Email" value={email} onChangeText={setEmail} placeholder="you@example.com" autoCapitalize="none" keyboardType="email-address" />
        <Field label="Password" value={pw} onChangeText={setPw} secureTextEntry autoCapitalize="none" />
        {!!err && <Text style={{ color: C.red, marginBottom: 12 }}>{err}</Text>}
        <Btn label={busy ? 'Signing in…' : 'Sign in'} onPress={go} disabled={busy} />
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

// ------------------------------------------------------------------ Today
const DELIVERY = {
  sent: { t: 'Sent to ChatGPT', icon: 'checkmark-done', bg: C.greenSoft, fg: C.green },
  sending: { t: 'Sending…', icon: 'sync-outline', bg: C.primarySoft, fg: C.primary },
  pending: { t: 'Waiting for your laptop', icon: 'hourglass-outline', bg: C.amberSoft, fg: C.amber },
  queued: { t: 'Queued on phone', icon: 'cloud-upload-outline', bg: C.redSoft, fg: C.red },
};

function Today({ habits, decisions, snoozes, onDecide, goHabits }) {
  const now = new Date();
  const today = dayKey(now);
  const active = habits.filter((h) => h.enabled);
  return (
    <View>
      <Text style={s.kicker}>TODAY</Text>
      <Text style={s.h1}>{formatDateLong(now)}</Text>
      {active.length === 0 && (
        <Card>
          <Text style={{ color: C.sub, marginBottom: 14, lineHeight: 20 }}>No habits yet. Create your first one and paste its ChatGPT chat link.</Text>
          <Btn icon="add" label="Add a habit" onPress={goHabits} />
        </Card>
      )}
      {active.map((h) => {
        const todays = decisions.filter((d) => d.habit_id === h.id && dayKey(new Date(d.decided_at)) === today);
        const final = todays.find((d) => d.decision !== 'snoozed');
        const [hh, mm] = h.remind_time.split(':').map(Number);
        const due = new Date(); due.setHours(hh, mm, 0, 0);
        const sn = snoozes[h.id] && snoozes[h.id] > Date.now() ? snoozes[h.id] : null;
        let chip = { t: `Reminds at ${fmtHHMM(h.remind_time)}`, bg: C.primarySoft, fg: C.primary, icon: 'alarm-outline' };
        if (final?.decision === 'going') chip = { t: 'Going', bg: C.greenSoft, fg: C.green, icon: 'checkmark-circle' };
        else if (final) chip = { t: 'Skipped today', bg: C.redSoft, fg: C.red, icon: 'close-circle' };
        else if (sn) chip = { t: `Snoozed until ${timeOnly(new Date(sn))}`, bg: C.amberSoft, fg: C.amber, icon: 'time-outline' };
        else if (now >= due) chip = { t: 'Due now', bg: C.amberSoft, fg: C.amber, icon: 'notifications' };
        const dv = final ? DELIVERY[final.status] || DELIVERY.pending : null;
        return (
          <Card key={h.id}>
            <View style={s.row}>
              <View style={s.iconCircle}><Icon name={iconFor(h)} size={22} color={C.primary} /></View>
              <View style={{ flex: 1 }}>
                <Text style={s.cardTitle}>{h.name}</Text>
                <Chip {...chip} />
              </View>
            </View>
            {final ? (
              <View>
                <Text style={s.msg}>“{final.message}”</Text>
                {dv && <View style={{ marginTop: 10 }}><Chip {...dv} /></View>}
              </View>
            ) : (
              <View style={{ marginTop: 14, gap: 10 }}>
                <Btn icon="checkmark-circle" label="I'M GOING" color={C.green} onPress={() => onDecide(h, 'going')} />
                <Btn icon="close-circle" label="I'M NOT GOING" color={C.red} onPress={() => onDecide(h, 'not_going')} />
                <Btn icon="time-outline" label={`SNOOZE ${h.snooze_minutes || 15} MIN`} color={C.amber} outline onPress={() => onDecide(h, 'snoozed')} />
              </View>
            )}
          </Card>
        );
      })}
    </View>
  );
}

// ------------------------------------------------------------------ Habits
const fmtEvery = (sec) => (sec % 60 === 0 ? `${sec / 60} min` : `${sec}s`);
function Habits({ habits, onEdit }) {
  return (
    <View>
      <Text style={s.kicker}>MANAGE</Text>
      <Text style={s.h1}>Your habits</Text>
      {habits.length === 0 && <Text style={{ color: C.sub }}>Nothing yet. Tap “New habit”.</Text>}
      {habits.map((h) => (
        <TouchableOpacity key={h.id} onPress={() => onEdit({ ...h })} activeOpacity={0.85}>
          <Card>
            <View style={s.row}>
              <View style={s.iconCircle}><Icon name={iconFor(h)} size={22} color={C.primary} /></View>
              <View style={{ flex: 1 }}>
                <Text style={s.cardTitle}>{h.name}</Text>
                <Text style={s.sub}>{fmtHHMM(h.remind_time)} · repeats every {fmtEvery(h.repeat_seconds)} · snooze {h.snooze_minutes} min</Text>
              </View>
              <Chip t={h.enabled ? 'On' : 'Paused'} bg={h.enabled ? C.greenSoft : C.line} fg={h.enabled ? C.green : C.sub} />
            </View>
            <View style={[s.row, { marginTop: 10 }]}>
              <Icon name="chatbubble-ellipses-outline" size={15} color={C.sub} />
              <Text style={[s.sub, { flex: 1, marginTop: 0 }]} numberOfLines={1}>{h.chat_url}</Text>
            </View>
          </Card>
        </TouchableOpacity>
      ))}
    </View>
  );
}

// ------------------------------------------------------------------ History
const DEC = {
  going: { icon: 'checkmark-circle', color: C.green },
  not_going: { icon: 'close-circle', color: C.red },
  snoozed: { icon: 'time', color: C.amber },
};
function History({ decisions, habits, onRetry }) {
  const [filter, setFilter] = useState('all');
  const list = decisions.filter((d) => filter === 'all' || d.habit_id === filter);
  const n = (k) => list.filter((d) => d.decision === k).length;
  return (
    <View>
      <Text style={s.kicker}>LOG</Text>
      <Text style={s.h1}>History</Text>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginBottom: 12 }}>
        {[{ id: 'all', name: 'All' }, ...habits].map((h) => (
          <TouchableOpacity key={h.id} onPress={() => setFilter(h.id)} style={[s.filterChip, filter === h.id && { backgroundColor: C.primary, borderColor: C.primary }]}>
            <Text style={{ color: filter === h.id ? '#fff' : C.ink, fontWeight: '600' }}>{h.name}</Text>
          </TouchableOpacity>
        ))}
      </ScrollView>
      <View style={[s.row, { marginBottom: 14, gap: 14 }]}>
        <Stat icon="checkmark-circle" color={C.green} n={n('going')} l="going" />
        <Stat icon="close-circle" color={C.red} n={n('not_going')} l="not going" />
        <Stat icon="time" color={C.amber} n={n('snoozed')} l="snoozed" />
      </View>
      {list.length === 0 && <Text style={{ color: C.sub }}>No decisions yet.</Text>}
      {list.map((d) => {
        const dv = DELIVERY[d.status] || DELIVERY.pending;
        const di = DEC[d.decision] || DEC.going;
        return (
          <Card key={d.id}>
            <View style={s.row}>
              <Icon name={di.icon} size={22} color={di.color} />
              <Text style={[s.cardTitle, { flex: 1 }]}>{d.habit_name}</Text>
              <Text style={s.sub}>{formatStamp(new Date(d.decided_at))}</Text>
            </View>
            <Text style={s.msg}>{d.message}</Text>
            <View style={[s.row, { marginTop: 10, justifyContent: 'space-between' }]}>
              <Chip {...dv} />
              {d.status === 'pending' && d.next_attempt_at && (
                <TouchableOpacity onPress={() => onRetry(d.id)}><Text style={{ color: C.primary, fontWeight: '700' }}>Retry now</Text></TouchableOpacity>
              )}
            </View>
            {!!d.last_error && d.status !== 'sent' && <Text style={{ color: C.red, fontSize: 12, marginTop: 6 }}>Last error: {d.last_error}</Text>}
          </Card>
        );
      })}
    </View>
  );
}

// ------------------------------------------------------------------ Settings
function Settings({ cfg, offline, onSignOut, onRefresh }) {
  const [box, setBox] = useState(0);
  const [st, setSt] = useState({});
  const [tone, setTone] = useState('');
  const load = useCallback(() => { setSt(Alarm.status()); setTone(Alarm.soundName()); getOutbox().then((b) => setBox(b.length)); }, []);
  useEffect(() => { load(); const sub = AppState.addEventListener('change', (x) => x === 'active' && load()); return () => sub.remove(); }, [load, offline]);

  const pick = async () => {
    try {
      const r = await DocumentPicker.getDocumentAsync({ type: 'audio/*', copyToCacheDirectory: true });
      if (r.canceled || !r.assets?.length) return;
      const a = r.assets[0];
      await Alarm.setSound(a.uri, a.name || 'Custom sound');
      setTone(a.name || 'Custom sound');
      toast('Alarm sound updated');
    } catch (e) { Alert.alert('Could not use that file', String(e.message || e)); }
  };

  const Row = ({ ok, label, kind, hint }) => (
    <View style={[s.row, { paddingVertical: 8 }]}>
      <Icon name={ok ? 'checkmark-circle' : 'alert-circle'} size={22} color={ok ? C.green : C.amber} />
      <View style={{ flex: 1 }}>
        <Text style={{ color: C.ink, fontWeight: '600' }}>{label}</Text>
        {!ok && <Text style={s.sub}>{hint}</Text>}
      </View>
      {!ok && <TouchableOpacity onPress={() => Alarm.openSettings(kind)}><Text style={{ color: C.primary, fontWeight: '800' }}>FIX</Text></TouchableOpacity>}
    </View>
  );

  return (
    <View>
      <Text style={s.kicker}>PREFERENCES</Text>
      <Text style={s.h1}>Settings</Text>

      <Card>
        <View style={s.row}><Icon name="musical-notes-outline" size={20} color={C.primary} /><Text style={s.cardTitle}>Alarm sound</Text></View>
        <Text style={s.sub}>{tone ? `Your sound: ${tone}` : 'Default alarm tone'}. Plays on the alarm volume until you answer.</Text>
        <View style={{ marginTop: 12, gap: 10 }}>
          <Btn icon="cloud-upload-outline" label="Upload your MP3" onPress={pick} />
          {!!tone && <Btn label="Back to default tone" outline onPress={() => { Alarm.clearSound(); setTone(''); }} />}
          <Btn icon="play-outline" label="Test alarm now" outline onPress={() => Alarm.testAlarm(0)} />
          <Btn icon="lock-closed-outline" label="Test in 10 sec (lock your phone)" outline onPress={() => { Alarm.testAlarm(10000); toast('Lock your phone now'); }} />
        </View>
      </Card>

      <Card>
        <View style={s.row}><Icon name="shield-checkmark-outline" size={20} color={C.primary} /><Text style={s.cardTitle}>Make alarms reliable</Text></View>
        <Row ok={st.notifications !== false} label="Notifications allowed" kind="notifications" hint="Needed to show the alarm." />
        <Row ok={st.exact !== false} label="Exact alarms allowed" kind="exact" hint="Lets Android ring exactly on time." />
        <Row ok={st.fullScreen !== false} label="Full-screen alarm on lock screen" kind="fullscreen" hint="Allow “full screen notifications”." />
        <Row ok={st.battery === true} label="Battery: unrestricted" kind="battery" hint="Stops Android from delaying alarms." />
      </Card>

      <Card>
        <View style={s.row}><Icon name="person-circle-outline" size={20} color={C.primary} /><Text style={s.cardTitle}>Account & sync</Text></View>
        <Text style={s.sub}>{cfg.email}</Text>
        <Text style={s.sub}>{cfg.url}</Text>
        <Text style={s.sub}>Connection: {offline ? 'offline' : 'connected'} · queued on phone: {box}</Text>
        <View style={{ marginTop: 12, gap: 10 }}>
          <Btn icon="sync-outline" label="Sync & rebuild alarms" onPress={onRefresh} outline />
          <Btn icon="log-out-outline" label="Sign out" color={C.red} outline onPress={onSignOut} />
        </View>
      </Card>
    </View>
  );
}

// ------------------------------------------------------------------ Habit editor
function HabitEditor({ habit, onClose, onSaved }) {
  const [h, setH] = useState(habit);
  const [busy, setBusy] = useState(false);
  const initial = presetFor(habit)?.key || (habit.id ? 'custom' : 'walk');
  const [preset, setPreset] = useState(initial);
  const set = (k, v) => setH((p) => ({ ...p, [k]: v }));
  const [hh, mm] = h.remind_time.split(':').map(Number);

  const choose = (p) => {
    const prev = PRESETS.find((x) => x.key === preset);
    setPreset(p.key);
    setH((cur) => ({
      ...cur,
      activity: p.activity || '',
      name: !cur.name.trim() || cur.name === prev?.label ? (p.key === 'custom' ? '' : p.label) : cur.name,
    }));
  };

  const pickTime = () => {
    const d = new Date(); d.setHours(hh, mm, 0, 0);
    DateTimePickerAndroid.open({
      value: d, mode: 'time', is24Hour: false,
      onChange: (e, date) => { if (e.type === 'set' && date) set('remind_time', `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`); },
    });
  };

  const save = async () => {
    if (!h.name.trim()) return Alert.alert('Name needed', 'Give the habit a name.');
    if (!/^https:\/\/(chatgpt\.com|chat\.openai\.com)\/.+/i.test((h.chat_url || '').trim()))
      return Alert.alert('ChatGPT link needed', 'Paste the full URL of this habit’s ChatGPT chat, e.g. https://chatgpt.com/c/6ac12e7c-…');
    const rep = parseInt(String(h.repeat_seconds), 10);
    const snz = parseInt(String(h.snooze_minutes), 10);
    if (!(rep >= 60)) return Alert.alert('Repeat interval', 'Minimum is 60 seconds.');
    if (!(snz >= 1)) return Alert.alert('Snooze', 'Snooze must be at least 1 minute.');
    const p = PRESETS.find((x) => x.key === preset);
    const activity = p?.activity || (h.activity || '').trim() || null;
    setBusy(true);
    try {
      await saveHabit({ ...h, activity, name: h.name.trim(), chat_url: h.chat_url.trim(), repeat_seconds: rep, snooze_minutes: snz });
      onSaved();
    } catch (e) { Alert.alert('Could not save', e.message); setBusy(false); }
  };

  const del = () => Alert.alert('Delete habit?', 'History stays, alarms stop.', [
    { text: 'Cancel', style: 'cancel' },
    { text: 'Delete', style: 'destructive', onPress: async () => { try { await deleteHabit(h.id); onSaved(); } catch (e) { Alert.alert('Error', e.message); } } },
  ]);

  return (
    <Modal animationType="slide" onRequestClose={onClose}>
      <KeyboardAvoidingView style={s.fill} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView contentContainerStyle={{ padding: 20, paddingTop: 48 }} keyboardShouldPersistTaps="handled">
          <Text style={s.kicker}>{h.id ? 'EDIT' : 'NEW'}</Text>
          <Text style={s.h1}>{h.id ? 'Edit habit' : 'New habit'}</Text>

          <Text style={s.label}>What is it?</Text>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginBottom: 16 }}>
            {PRESETS.map((p) => (
              <TouchableOpacity key={p.key} onPress={() => choose(p)} activeOpacity={0.8}
                style={[s.preset, preset === p.key && { backgroundColor: C.primary, borderColor: C.primary }]}>
                <Icon name={p.icon} size={22} color={preset === p.key ? '#fff' : C.primary} />
                <Text style={{ marginTop: 4, fontWeight: '700', fontSize: 12, color: preset === p.key ? '#fff' : C.ink }}>{p.label}</Text>
              </TouchableOpacity>
            ))}
          </ScrollView>

          <Field label="Habit name" value={h.name} onChangeText={(v) => set('name', v)} placeholder="Evening Walk" />
          {preset === 'custom' && (
            <Field label="Message wording (optional)" value={h.activity || ''} onChangeText={(v) => set('activity', v)} placeholder="doing yoga"
              hint={`Empty = “I'm not doing ${h.name || 'it'} today”`} />
          )}
          <Text style={s.label}>Reminder time</Text>
          <TouchableOpacity style={[s.input, s.row, { marginBottom: 14 }]} onPress={pickTime}>
            <Text style={{ fontSize: 16, color: C.ink }}>{fmtHHMM(h.remind_time)}</Text><Icon name="time-outline" size={20} color={C.sub} />
          </TouchableOpacity>
          <Field label="Remind again every (seconds)" value={String(h.repeat_seconds)} onChangeText={(v) => set('repeat_seconds', v.replace(/\D/g, ''))}
            keyboardType="number-pad" hint="Min 60. The alarm rings, then rings again until you answer (up to ~2 hours)." />
          <Field label="Snooze (minutes)" value={String(h.snooze_minutes)} onChangeText={(v) => set('snooze_minutes', v.replace(/\D/g, ''))} keyboardType="number-pad" />
          <Field label="ChatGPT chat URL" value={h.chat_url} onChangeText={(v) => set('chat_url', v)} placeholder="https://chatgpt.com/c/…" autoCapitalize="none"
            hint="Open this habit's chat in ChatGPT and copy the link from the address bar." />
          <View style={[s.row, { marginVertical: 12 }]}><Text style={s.label}>Enabled</Text><Switch value={h.enabled} onValueChange={(v) => set('enabled', v)} trackColor={{ true: C.primary }} /></View>
          <Btn label={busy ? 'Saving…' : 'Save habit'} onPress={save} disabled={busy} />
          <View style={{ height: 10 }} />
          <Btn label="Cancel" outline onPress={onClose} />
          {h.id && <><View style={{ height: 10 }} /><Btn icon="trash-outline" label="Delete habit" color={C.red} outline onPress={del} /></>}
        </ScrollView>
      </KeyboardAvoidingView>
    </Modal>
  );
}

// ------------------------------------------------------------------ UI bits
const Card = ({ children }) => <View style={s.card}>{children}</View>;
const Chip = ({ t, bg, fg, icon }) => (
  <View style={[s.chip, { backgroundColor: bg }]}>
    {!!icon && <Icon name={icon} size={13} color={fg} />}
    <Text style={{ color: fg, fontWeight: '700', fontSize: 12 }}>{t}</Text>
  </View>
);
const Stat = ({ icon, color, n, l }) => (
  <View style={[s.row, { gap: 5 }]}><Icon name={icon} size={18} color={color} /><Text style={{ color: C.ink, fontWeight: '800' }}>{n}</Text><Text style={s.sub}>{l}</Text></View>
);
const Field = ({ label, hint, ...p }) => (
  <View style={{ marginBottom: 14 }}>
    <Text style={s.label}>{label}</Text>
    <TextInput style={s.input} placeholderTextColor="#A5A5BC" {...p} />
    {!!hint && <Text style={{ color: C.sub, fontSize: 12, marginTop: 4, lineHeight: 17 }}>{hint}</Text>}
  </View>
);
const Btn = ({ label, onPress, color = C.primary, outline, disabled, icon }) => (
  <TouchableOpacity onPress={onPress} disabled={disabled} activeOpacity={0.8}
    style={[s.btn, outline ? { borderColor: color, borderWidth: 1.5, backgroundColor: 'transparent' } : { backgroundColor: color }, disabled && { opacity: 0.5 }]}>
    {!!icon && <Icon name={icon} size={20} color={outline ? color : '#fff'} />}
    <Text style={[s.btnTxt, outline && { color }]}>{label}</Text>
  </TouchableOpacity>
);

const shadow = { shadowColor: '#2B2B6B', shadowOpacity: 0.07, shadowRadius: 12, shadowOffset: { width: 0, height: 4 }, elevation: 2 };
const s = StyleSheet.create({
  fill: { flex: 1, backgroundColor: C.bg }, center: { alignItems: 'center', justifyContent: 'center' },
  header: { flexDirection: 'row', alignItems: 'center', paddingTop: 50, paddingHorizontal: 16, paddingBottom: 6, gap: 10 },
  logo: { width: 36, height: 36, borderRadius: 11, backgroundColor: C.primary, alignItems: 'center', justifyContent: 'center' },
  title: { fontSize: 24, fontWeight: '800', color: C.ink, letterSpacing: -0.5 },
  offPill: { flexDirection: 'row', alignItems: 'center', gap: 4, backgroundColor: C.redSoft, borderRadius: 10, paddingHorizontal: 8, paddingVertical: 3 },
  offTxt: { color: C.red, fontSize: 12, fontWeight: '700' },
  kicker: { fontSize: 11, fontWeight: '800', color: C.primary, letterSpacing: 1.4 },
  h1: { fontSize: 26, fontWeight: '800', color: C.ink, marginBottom: 14, marginTop: 2, letterSpacing: -0.5 },
  card: { backgroundColor: C.card, borderRadius: 20, padding: 16, marginBottom: 14, ...shadow },
  iconCircle: { width: 44, height: 44, borderRadius: 14, backgroundColor: C.primarySoft, alignItems: 'center', justifyContent: 'center' },
  cardTitle: { fontSize: 17, fontWeight: '800', color: C.ink, marginBottom: 4 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  sub: { color: C.sub, fontSize: 13, marginTop: 3, lineHeight: 19 },
  msg: { color: C.ink, marginTop: 12, fontSize: 14, lineHeight: 21 },
  chip: { flexDirection: 'row', alignItems: 'center', gap: 4, alignSelf: 'flex-start', borderRadius: 12, paddingHorizontal: 10, paddingVertical: 4 },
  filterChip: { backgroundColor: C.card, borderRadius: 18, paddingHorizontal: 16, paddingVertical: 9, marginRight: 8, borderWidth: 1, borderColor: C.line },
  preset: { width: 78, height: 74, borderRadius: 18, backgroundColor: C.card, borderWidth: 1.5, borderColor: C.line, alignItems: 'center', justifyContent: 'center', marginRight: 10 },
  label: { fontSize: 13, fontWeight: '700', color: C.ink, marginBottom: 7 },
  input: { backgroundColor: C.card, borderWidth: 1, borderColor: C.line, borderRadius: 14, paddingHorizontal: 14, paddingVertical: 13, fontSize: 16, color: C.ink },
  btn: { flexDirection: 'row', gap: 8, borderRadius: 16, paddingVertical: 15, alignItems: 'center', justifyContent: 'center' },
  btnTxt: { color: '#fff', fontWeight: '800', fontSize: 15, letterSpacing: 0.4 },
  tabs: { position: 'absolute', bottom: 0, left: 0, right: 0, flexDirection: 'row', backgroundColor: C.card, borderTopWidth: 1, borderColor: C.line, paddingBottom: 14, paddingTop: 9 },
  tab: { flex: 1, alignItems: 'center', gap: 2 }, tabTxt: { fontSize: 11, color: '#9A9AB5', fontWeight: '600' },
  fab: { position: 'absolute', right: 16, bottom: 92, flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: C.primary, borderRadius: 30, paddingHorizontal: 20, paddingVertical: 14, elevation: 5 },
  fabTxt: { color: '#fff', fontWeight: '800' },
});
