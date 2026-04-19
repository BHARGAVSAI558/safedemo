import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Keyboard,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import Constants from 'expo-constants';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import AppModal from './AppModal';
import { support } from '../services/api';
import { useAuth } from '../contexts/AuthContext';
import { useLocalization } from '../contexts/LocalizationContext';

function bcp47ForAppLang(code) {
  if (code === 'hi') return 'hi-IN';
  if (code === 'te') return 'te-IN';
  return 'en-IN';
}

function getSpeechModule() {
  if (Constants.appOwnership === 'expo') return null;
  try {
    // eslint-disable-next-line global-require
    const lib = require('expo-speech-recognition');
    return lib?.ExpoSpeechRecognitionModule || null;
  } catch (_) {
    return null;
  }
}

function getWebSpeechRecognitionCtor() {
  if (typeof window === 'undefined') return null;
  return window.SpeechRecognition || window.webkitSpeechRecognition || null;
}

const assistantContent = {
  en: {
    label: 'English',
    title: 'Support',
    close: 'Close',
    send: 'Send',
    queries: [
      { key: 'show_histories', text: 'Show my histories' },
      { key: 'no_payout', text: "Why didn’t I get payout?" },
      { key: 'claim_status', text: 'Check my claim status' },
      { key: 'disruption_active', text: 'Is disruption active?' },
      { key: 'payment_delayed', text: 'Payment delayed?' },
      { key: 'payout_calc', text: 'How is payout calculated?' },
      { key: 'explain_claim', text: 'Explain my claim' },
      { key: 'coverage', text: 'Am I covered?' },
      { key: 'raise_ticket', text: 'Raise a support ticket' },
    ],
    placeholder: 'Type your message...',
    empty: 'Ask a question. Support and admin replies will appear here.',
    systemLabel: 'System',
    adminLabel: 'Admin',
  },
  hi: {
    label: 'हिन्दी',
    title: 'Support',
    close: 'बंद करें',
    send: 'भेजें',
    queries: [
      { key: 'show_histories', text: 'मेरी हिस्ट्री दिखाएं' },
      { key: 'no_payout', text: 'मुझे भुगतान क्यों नहीं मिला?' },
      { key: 'claim_status', text: 'मेरे क्लेम की स्थिति क्या है?' },
      { key: 'disruption_active', text: 'क्या अभी व्यवधान सक्रिय है?' },
      { key: 'payment_delayed', text: 'भुगतान में देरी क्यों है?' },
      { key: 'payout_calc', text: 'भुगतान कैसे गणना होता है?' },
      { key: 'explain_claim', text: 'मेरे क्लेम की जानकारी बताएं' },
      { key: 'coverage', text: 'क्या मैं अभी कवर में हूँ?' },
      { key: 'raise_ticket', text: 'सपोर्ट टिकट बनाएं' },
    ],
    placeholder: 'अपना संदेश लिखें...',
    empty: 'अपना प्रश्न भेजें। सपोर्ट और एडमिन के जवाब यहां दिखेंगे।',
    systemLabel: 'सिस्टम',
    adminLabel: 'एडमिन',
  },
  te: {
    label: 'తెలుగు',
    title: 'Support',
    close: 'మూసివేయి',
    send: 'పంపు',
    queries: [
      { key: 'show_histories', text: 'నా హిస్టరీ చూపించు' },
      { key: 'no_payout', text: 'నాకు చెల్లింపు ఎందుకు రాలేదు?' },
      { key: 'claim_status', text: 'నా క్లెయిమ్ స్థితి ఏమిటి?' },
      { key: 'disruption_active', text: 'ప్రస్తుతం అంతరాయం ఉందా?' },
      { key: 'payment_delayed', text: 'చెల్లింపు ఆలస్యం ఎందుకు?' },
      { key: 'payout_calc', text: 'చెల్లింపు ఎలా గణించబడుతుంది?' },
      { key: 'explain_claim', text: 'నా క్లెయిమ్ వివరాలు చెప్పండి' },
      { key: 'coverage', text: 'నేను ప్రస్తుతం కవర్లో ఉన్నానా?' },
      { key: 'raise_ticket', text: 'సపోర్ట్ టికెట్ నమోదు చేయండి' },
    ],
    placeholder: 'మీ సందేశాన్ని టైప్ చేయండి...',
    empty: 'మీ ప్రశ్నను పంపండి. సపోర్ట్/అడ్మిన్ సమాధానాలు ఇక్కడ కనిపిస్తాయి.',
    systemLabel: 'సిస్టమ్',
    adminLabel: 'అడ్మిన్',
  },
};

export default function AssistantModal({ visible, onClose }) {
  const { userId } = useAuth();
  const qc = useQueryClient();
  const { language, setLanguage: setAppLanguage, t: tloc } = useLocalization();
  const [message, setMessage] = useState('');
  const [selectedLanguage, setSelectedLanguage] = useState('en');
  const [languageOpen, setLanguageOpen] = useState(false);
  const [ticketText, setTicketText] = useState('');
  const [ticketOpen, setTicketOpen] = useState(false);
  const [recognizing, setRecognizing] = useState(false);
  const [voiceNote, setVoiceNote] = useState('');
  const [voiceTarget, setVoiceTarget] = useState('message');
  const currentTranscriptRef = useRef('');
  const baseVoiceTextRef = useRef('');
  const fullTranscriptRef = useRef('');
  const historyRef = useRef(null);
  const speechModuleRef = useRef(null);
  const webRecognitionRef = useRef(null);
  const inputRef = useRef(null);

  const historyQuery = useQuery({
    queryKey: ['supportHistory', userId],
    queryFn: () => support.history(userId),
    enabled: visible && Boolean(userId),
    staleTime: 10_000,
    refetchInterval: visible ? 5_000 : false,
  });

  const sendMutation = useMutation({
    mutationFn: ({ text, type, queryKey }) =>
      support.query({
        user_id: String(userId || ''),
        message: text,
        type,
        language: selectedLanguage,
        query_key: queryKey || null,
      }),
    onSuccess: () => {
      setMessage('');
      void qc.invalidateQueries({ queryKey: ['supportHistory', userId] });
    },
  });

  const items = useMemo(() => (Array.isArray(historyQuery.data) ? historyQuery.data : []), [historyQuery.data]);
  const dateFmt = useMemo(
    () =>
      new Intl.DateTimeFormat('en-IN', {
        day: '2-digit',
        month: 'short',
        year: 'numeric',
      }),
    []
  );
  const timeFmt = useMemo(
    () =>
      new Intl.DateTimeFormat('en-IN', {
        hour: '2-digit',
        minute: '2-digit',
      }),
    []
  );

  const send = (text, type = 'custom', queryKey = null) => {
    const trimmed = String(text || '').trim();
    if (!trimmed || sendMutation.isPending) return;
    sendMutation.mutate({ text: trimmed, type, queryKey });
  };
  const raiseTicket = () => {
    const txt = String(ticketText || '').trim();
    if (!txt || sendMutation.isPending) return;
    send(txt, 'ticket', 'raise_ticket');
    setTicketText('');
  };
  const languagePack = assistantContent[selectedLanguage] || assistantContent.en;

  useEffect(() => {
    if (visible) setSelectedLanguage(language);
  }, [visible, language]);

  const stopWebRecognition = useCallback(() => {
    try {
      const r = webRecognitionRef.current;
      if (r) {
        r.onresult = null;
        r.onerror = null;
        r.onend = null;
        r.stop?.();
        r.abort?.();
      }
    } catch (_) {}
    webRecognitionRef.current = null;
  }, []);

  useEffect(() => {
    if (!visible) {
      try {
        speechModuleRef.current?.stop?.();
      } catch (_) {}
      stopWebRecognition();
      setRecognizing(false);
    }
  }, [visible, stopWebRecognition]);

  useEffect(() => {
    const sm = getSpeechModule();
    speechModuleRef.current = sm;
    if (!sm?.addListener) return undefined;

    const startSub = sm.addListener('start', () => setRecognizing(true));
    const endSub = sm.addListener('end', () => {
      setRecognizing(false);
      currentTranscriptRef.current = '';
      baseVoiceTextRef.current = '';
      fullTranscriptRef.current = '';
    });
    const errorSub = sm.addListener('error', () => {
      setRecognizing(false);
      currentTranscriptRef.current = '';
      baseVoiceTextRef.current = '';
      fullTranscriptRef.current = '';
    });
    const resultSub = sm.addListener('result', (event) => {
      const parts = (event?.results || [])
        .map((r) => String(r?.transcript || '').trim())
        .filter(Boolean);
      const transcript = parts.join(' ').trim();
      if (!transcript) return;
      if (transcript === currentTranscriptRef.current || transcript === fullTranscriptRef.current) return;
      currentTranscriptRef.current = transcript;
      fullTranscriptRef.current = transcript;
      const merged = `${baseVoiceTextRef.current} ${fullTranscriptRef.current}`.trim();
      if (voiceTarget === 'ticket') setTicketText(merged);
      else setMessage(merged);
    });

    return () => {
      startSub?.remove?.();
      endSub?.remove?.();
      errorSub?.remove?.();
      resultSub?.remove?.();
    };
  }, [voiceTarget]);

  const toggleVoice = async (target = 'message') => {
    try {
      if (Platform.OS === 'web') {
        const Ctor = getWebSpeechRecognitionCtor();
        if (recognizing) {
          stopWebRecognition();
          setRecognizing(false);
          return;
        }
        if (!Ctor) {
          setVoiceNote('Voice input is not supported in this browser. Use Chrome or Edge.');
          return;
        }
        setVoiceTarget(target);
        baseVoiceTextRef.current =
          target === 'ticket' ? String(ticketText || '').trim() : String(message || '').trim();
        currentTranscriptRef.current = '';
        fullTranscriptRef.current = '';
        stopWebRecognition();
        const rec = new Ctor();
        rec.lang = bcp47ForAppLang(selectedLanguage);
        rec.interimResults = true;
        rec.continuous = true;
        rec.onresult = (event) => {
          let chunk = '';
          for (let i = event.resultIndex; i < event.results.length; i += 1) {
            chunk += event.results[i][0].transcript;
          }
          const merged = `${baseVoiceTextRef.current} ${chunk}`.trim();
          if (target === 'ticket') setTicketText(merged);
          else setMessage(merged);
        };
        rec.onerror = () => {
          stopWebRecognition();
          setRecognizing(false);
        };
        rec.onend = () => {
          webRecognitionRef.current = null;
          setRecognizing(false);
        };
        webRecognitionRef.current = rec;
        rec.start();
        setRecognizing(true);
        return;
      }

      const sm = speechModuleRef.current || getSpeechModule();
      speechModuleRef.current = sm;
      if (!sm) {
        setVoiceNote('Voice input needs a Development Build on mobile. In Expo Go use keyboard mic typing.');
        inputRef.current?.focus?.();
        return;
      }
      if (recognizing) {
        sm.stop();
        return;
      }
      setVoiceTarget(target);
      const perm = await sm.requestPermissionsAsync();
      if (!perm.granted) {
        setVoiceNote('Allow microphone access to use voice input.');
        return;
      }
      setVoiceNote('');
      baseVoiceTextRef.current =
        target === 'ticket'
          ? String(ticketText || '').trim()
          : String(message || '').trim();
      currentTranscriptRef.current = '';
      fullTranscriptRef.current = '';
      sm.start({
        lang: bcp47ForAppLang(selectedLanguage),
        interimResults: true,
        continuous: true,
      });
    } catch (e) {
      setVoiceNote(e?.message || 'Speech recognition is unavailable here. Use keyboard voice typing.');
    }
  };

  useEffect(() => {
    if (!visible) return undefined;
    const scrollTimer = setTimeout(() => {
      historyRef.current?.scrollToEnd?.({ animated: true });
    }, 60);
    return () => clearTimeout(scrollTimer);
  }, [visible, items.length, ticketOpen, languageOpen]);

  return (
    <AppModal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
      <Pressable style={styles.wrap} onPress={Keyboard.dismiss}>
        <KeyboardAvoidingView
          style={styles.keyboardWrap}
          behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
          keyboardVerticalOffset={Platform.OS === 'ios' ? 12 : 0}
        >
          <Pressable style={styles.card} onPress={() => {}}>
          <View style={styles.head}>
            <View style={styles.headLeft}>
              <TouchableOpacity
                style={[styles.raiseTicketTopBtn, ticketOpen && styles.raiseTicketTopBtnActive]}
                onPress={() => setTicketOpen((v) => !v)}
              >
                <Text style={styles.raiseTicketTopBtnText}>Raise Ticket</Text>
              </TouchableOpacity>
              <Text style={styles.title}>{languagePack.title}</Text>
            </View>
            <View style={styles.headActions}>
              <TouchableOpacity style={styles.langBtn} onPress={() => setLanguageOpen((v) => !v)}>
                <Text style={styles.langBtnText}>🌐 {languagePack.label}</Text>
              </TouchableOpacity>
              <TouchableOpacity onPress={onClose}>
                <Text style={styles.close}>{languagePack.close}</Text>
              </TouchableOpacity>
            </View>
          </View>
          {languageOpen ? (
            <View style={styles.langMenu}>
              {[
                { id: 'en', label: 'English' },
                { id: 'hi', label: 'हिन्दी' },
                { id: 'te', label: 'తెలుగు' },
              ].map((row) => (
                <TouchableOpacity
                  key={row.id}
                  style={[styles.langItem, selectedLanguage === row.id && styles.langItemActive]}
                  onPress={() => {
                    setSelectedLanguage(row.id);
                    void setAppLanguage(row.id);
                    setLanguageOpen(false);
                  }}
                >
                  <Text style={[styles.langItemText, selectedLanguage === row.id && styles.langItemTextActive]}>
                    {row.label}
                  </Text>
                </TouchableOpacity>
              ))}
            </View>
          ) : null}

          <ScrollView
            ref={historyRef}
            style={styles.history}
            contentContainerStyle={styles.historyContent}
            keyboardShouldPersistTaps="handled"
            keyboardDismissMode={Platform.OS === 'ios' ? 'interactive' : 'on-drag'}
            onContentSizeChange={() => historyRef.current?.scrollToEnd?.({ animated: false })}
          >
            {historyQuery.isLoading ? (
              <ActivityIndicator color="#1a73e8" />
            ) : items.length === 0 ? (
              <Text style={styles.empty}>{languagePack.empty}</Text>
            ) : (
              items.map((row, idx) => {
                const created = new Date(row?.created_at || Date.now());
                const dayKey = Number.isNaN(created.getTime()) ? `d-${idx}` : created.toDateString();
                const prev = idx > 0 ? new Date(items[idx - 1]?.created_at || Date.now()) : null;
                const showDay = !prev || prev.toDateString() !== dayKey;
                const dayText = Number.isNaN(created.getTime()) ? 'Today' : dateFmt.format(created);
                const timeText = Number.isNaN(created.getTime()) ? '--:--' : timeFmt.format(created);
                return (
                  <View key={String(row.id)} style={{ marginBottom: 12 }}>
                    {showDay ? (
                      <View style={styles.dayPillWrap}>
                        <Text style={styles.dayPillText}>{dayText}</Text>
                      </View>
                    ) : null}
                    <View style={[styles.bubble, styles.userBubble]}>
                      <Text style={styles.userText}>{row.message}</Text>
                      <Text style={styles.userTime}>{timeText}</Text>
                    </View>
                    <View style={[styles.bubble, styles.systemBubble]}>
                      <Text style={styles.sysLabel}>{languagePack.systemLabel}</Text>
                      <Text style={styles.sysText}>{row.reply}</Text>
                      <Text style={styles.msgTime}>{timeText}</Text>
                    </View>
                    {row.admin_reply ? (
                      <View style={[styles.bubble, styles.adminBubble]}>
                        <Text style={styles.adminLabel}>{languagePack.adminLabel}</Text>
                        <Text style={styles.adminText}>{row.admin_reply}</Text>
                        <Text style={styles.msgTime}>{timeText}</Text>
                      </View>
                    ) : null}
                  </View>
                );
              })
            )}
          </ScrollView>

          {ticketOpen ? (
            <View style={styles.ticketBox}>
              <View style={styles.ticketHead}>
                <Text style={styles.ticketTitle}>Raise Ticket</Text>
                <View style={styles.ticketHeadActions}>
                  <TouchableOpacity
                    style={[styles.voiceBtn, recognizing && voiceTarget === 'ticket' && styles.voiceBtnOn]}
                    onPress={() => void toggleVoice('ticket')}
                    accessibilityRole="button"
                    accessibilityLabel={tloc('assistant.voice')}
                  >
                    <MaterialCommunityIcons name={recognizing ? 'microphone' : 'microphone-outline'} size={20} color={recognizing && voiceTarget === 'ticket' ? '#fff' : '#1a73e8'} />
                  </TouchableOpacity>
                  <TouchableOpacity style={styles.ticketCloseBtn} onPress={() => setTicketOpen(false)}>
                    <Text style={styles.ticketCloseText}>✕</Text>
                  </TouchableOpacity>
                </View>
              </View>
              <TextInput
                style={styles.ticketInput}
                placeholder="Describe issue for admin team... add Transaction ID if available"
                value={ticketText}
                onChangeText={setTicketText}
                multiline
                returnKeyType="done"
              />
              <TouchableOpacity style={styles.ticketBtn} onPress={raiseTicket} disabled={sendMutation.isPending || !String(ticketText).trim()}>
                <Text style={styles.ticketBtnText}>{sendMutation.isPending ? '...' : 'Raise Ticket'}</Text>
              </TouchableOpacity>
            </View>
          ) : (
            <ScrollView
              style={styles.quickStrip}
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={styles.quickRow}
              keyboardShouldPersistTaps="handled"
            >
              {languagePack.queries.map((q) => (
                <TouchableOpacity
                  key={`${selectedLanguage}-${q.key}`}
                  style={styles.quickBtn}
                  onPress={() => {
                    if (q.key === 'raise_ticket') {
                      setTicketOpen(true);
                      return;
                    }
                    send(q.text, 'predefined', q.key);
                  }}
                >
                  <Text style={styles.quickText}>{q.text}</Text>
                </TouchableOpacity>
              ))}
            </ScrollView>
          )}

          <View style={styles.inputRow}>
            <TextInput
              ref={inputRef}
              style={styles.input}
              placeholder={recognizing ? tloc('assistant.listening') : languagePack.placeholder}
              value={message}
              onChangeText={setMessage}
              returnKeyType="send"
              onSubmitEditing={() => send(message)}
            />
            <TouchableOpacity
              style={[styles.voiceBtn, recognizing && voiceTarget === 'message' && styles.voiceBtnOn]}
              onPress={() => void toggleVoice('message')}
              accessibilityRole="button"
              accessibilityLabel={tloc('assistant.voice')}
            >
              <MaterialCommunityIcons name={recognizing ? 'microphone' : 'microphone-outline'} size={22} color={recognizing && voiceTarget === 'message' ? '#fff' : '#1a73e8'} />
            </TouchableOpacity>
            <TouchableOpacity style={styles.send} onPress={() => send(message)}>
              <Text style={styles.sendText}>{sendMutation.isPending ? '...' : languagePack.send}</Text>
            </TouchableOpacity>
          </View>
          <Text style={styles.voiceHint}>{voiceNote || tloc('assistant.voice_hint')}</Text>
          </Pressable>
        </KeyboardAvoidingView>
      </Pressable>
    </AppModal>
  );
}

const styles = StyleSheet.create({
  wrap: { flex: 1, backgroundColor: 'rgba(0,0,0,0.35)', justifyContent: 'flex-end' },
  keyboardWrap: { flex: 1, width: '100%', justifyContent: 'flex-end' },
  card: {
    backgroundColor: '#fff',
    borderTopLeftRadius: 18,
    borderTopRightRadius: 18,
    height: '80%',
    maxHeight: '80%',
    paddingHorizontal: 12,
    paddingTop: 12,
    paddingBottom: 10,
    borderTopWidth: 1,
    borderColor: '#e2e8f0',
  },
  head: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  headLeft: { flexDirection: 'row', alignItems: 'center', gap: 8, flex: 1 },
  headActions: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  raiseTicketTopBtn: {
    backgroundColor: '#f59e0b',
    borderRadius: 10,
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  raiseTicketTopBtnActive: { backgroundColor: '#b45309' },
  raiseTicketTopBtnText: { color: '#fff', fontWeight: '900', fontSize: 11, textTransform: 'uppercase' },
  langBtn: { borderWidth: 1, borderColor: '#cbd5e1', borderRadius: 999, paddingHorizontal: 8, paddingVertical: 5 },
  langBtnText: { fontSize: 12, color: '#334155', fontWeight: '700' },
  langMenu: {
    alignSelf: 'flex-end',
    marginTop: 8,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    borderRadius: 10,
    backgroundColor: '#fff',
    overflow: 'hidden',
  },
  langItem: { paddingHorizontal: 12, paddingVertical: 8 },
  langItemActive: { backgroundColor: '#eff6ff' },
  langItemText: { color: '#334155', fontWeight: '600' },
  langItemTextActive: { color: '#1d4ed8', fontWeight: '800' },
  title: { fontSize: 16, fontWeight: '900', color: '#0f172a', flexShrink: 1 },
  close: { color: '#1a73e8', fontWeight: '700' },
  history: { marginTop: 8, flex: 1, minHeight: 140 },
  historyContent: { paddingBottom: 10, paddingHorizontal: 2 },
  dayPillWrap: { alignItems: 'center', marginVertical: 4 },
  dayPillText: {
    fontSize: 11,
    color: '#475569',
    backgroundColor: '#e2e8f0',
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 4,
    fontWeight: '700',
  },
  empty: { color: '#64748b', fontSize: 13 },
  bubble: { borderRadius: 12, padding: 10, marginTop: 6, maxWidth: '85%' },
  userBubble: { alignSelf: 'flex-end', backgroundColor: '#1a73e8' },
  userText: { color: '#fff', fontWeight: '700' },
  userTime: { color: 'rgba(255,255,255,0.8)', fontSize: 10, marginTop: 6, textAlign: 'right' },
  systemBubble: { alignSelf: 'flex-start', backgroundColor: '#f1f5f9', borderWidth: 1, borderColor: '#e2e8f0' },
  sysLabel: { fontSize: 10, fontWeight: '900', color: '#475569', marginBottom: 4, textTransform: 'uppercase' },
  sysText: { color: '#0f172a', fontSize: 13 },
  adminBubble: { alignSelf: 'flex-start', backgroundColor: '#ecfeff', borderWidth: 1, borderColor: '#bae6fd' },
  adminLabel: { fontSize: 10, fontWeight: '900', color: '#0c4a6e', marginBottom: 4, textTransform: 'uppercase' },
  adminText: { color: '#0f172a', fontSize: 13, fontWeight: '700' },
  msgTime: { color: '#64748b', fontSize: 10, marginTop: 6, textAlign: 'right' },
  quickStrip: {
    marginTop: 6,
    maxHeight: 58,
    minHeight: 58,
    borderTopWidth: 1,
    borderTopColor: '#e2e8f0',
    borderBottomWidth: 1,
    borderBottomColor: '#e2e8f0',
  },
  quickRow: { gap: 8, paddingVertical: 10, alignItems: 'center' },
  quickBtn: {
    borderRadius: 6,
    borderWidth: 1,
    borderColor: '#cbd5e1',
    backgroundColor: '#f8fafc',
    paddingVertical: 7,
    paddingHorizontal: 10,
    alignSelf: 'center',
    maxWidth: 210,
    minHeight: 32,
    justifyContent: 'center',
  },
  quickText: { color: '#334155', fontSize: 11, fontWeight: '700' },
  inputRow: { flexDirection: 'row', gap: 8, alignItems: 'center', marginTop: 8, marginBottom: 4 },
  input: { flex: 1, borderWidth: 1, borderColor: '#e2e8f0', borderRadius: 10, paddingHorizontal: 10, paddingVertical: 10, fontSize: 14 },
  voiceBtn: {
    borderWidth: 1.5,
    borderColor: '#cbd5e1',
    borderRadius: 999,
    width: 44,
    height: 44,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#f8fafc',
  },
  voiceBtnOn: { borderColor: '#dc2626', backgroundColor: '#dc2626' },
  voiceHint: { fontSize: 11, color: '#64748b', fontWeight: '600', marginBottom: 4 },
  send: { backgroundColor: '#1a73e8', borderRadius: 10, paddingHorizontal: 14, paddingVertical: 10 },
  sendText: { color: '#fff', fontWeight: '800' },
  ticketBox: {
    marginTop: 8,
    borderWidth: 1,
    borderColor: '#f59e0b',
    backgroundColor: '#fff7ed',
    borderRadius: 12,
    padding: 10,
  },
  ticketHead: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 },
  ticketHeadActions: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  ticketCloseBtn: { width: 28, height: 28, borderRadius: 14, alignItems: 'center', justifyContent: 'center', backgroundColor: '#ffedd5' },
  ticketCloseText: { color: '#b45309', fontWeight: '900', fontSize: 14 },
  ticketTitle: { fontSize: 12, fontWeight: '900', color: '#b45309', marginBottom: 6, textTransform: 'uppercase' },
  ticketInput: {
    minHeight: 70,
    borderWidth: 1,
    borderColor: '#fdba74',
    borderRadius: 10,
    backgroundColor: '#fff',
    paddingHorizontal: 10,
    paddingVertical: 8,
    fontSize: 13,
    color: '#111827',
    textAlignVertical: 'top',
  },
  ticketBtn: {
    marginTop: 8,
    alignSelf: 'flex-end',
    backgroundColor: '#f59e0b',
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  ticketBtnText: { color: '#fff', fontWeight: '900', fontSize: 12 },
});

