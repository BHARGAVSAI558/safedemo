import React, { useMemo, useState } from 'react';
import { ActivityIndicator, ScrollView, StyleSheet, Text, TextInput, TouchableOpacity, View } from 'react-native';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import AppModal from './AppModal';
import { support } from '../services/api';
import { useAuth } from '../contexts/AuthContext';

const assistantContent = {
  en: {
    label: 'English',
    title: 'Support Assistant',
    close: 'Close',
    send: 'Send',
    queries: [
      { key: 'no_payout', text: "Why didn’t I get payout?" },
      { key: 'claim_status', text: 'Check my claim status' },
      { key: 'disruption_active', text: 'Is disruption active?' },
      { key: 'payment_delayed', text: 'Payment delayed?' },
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
    title: 'सहायता सहायक',
    close: 'बंद करें',
    send: 'भेजें',
    queries: [
      { key: 'no_payout', text: 'मुझे भुगतान क्यों नहीं मिला?' },
      { key: 'claim_status', text: 'मेरे क्लेम की स्थिति क्या है?' },
      { key: 'disruption_active', text: 'क्या अभी व्यवधान सक्रिय है?' },
      { key: 'payment_delayed', text: 'भुगतान में देरी क्यों है?' },
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
    title: 'సపోర్ట్ అసిస్టెంట్',
    close: 'మూసివేయి',
    send: 'పంపు',
    queries: [
      { key: 'no_payout', text: 'నాకు చెల్లింపు ఎందుకు రాలేదు?' },
      { key: 'claim_status', text: 'నా క్లెయిమ్ స్థితి ఏమిటి?' },
      { key: 'disruption_active', text: 'ప్రస్తుతం అంతరాయం ఉందా?' },
      { key: 'payment_delayed', text: 'చెల్లింపు ఆలస్యం ఎందుకు?' },
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
  const [message, setMessage] = useState('');
  const [selectedLanguage, setSelectedLanguage] = useState('en');
  const [languageOpen, setLanguageOpen] = useState(false);

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
  const languagePack = assistantContent[selectedLanguage] || assistantContent.en;

  return (
    <AppModal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
      <View style={styles.wrap}>
        <View style={styles.card}>
          <View style={styles.head}>
            <Text style={styles.title}>{languagePack.title}</Text>
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

          <ScrollView style={styles.history} contentContainerStyle={styles.historyContent}>
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

          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.quickRow}>
            {languagePack.queries.map((q) => (
              <TouchableOpacity
                key={`${selectedLanguage}-${q.key}`}
                style={styles.quickBtn}
                onPress={() => send(q.text, q.key === 'raise_ticket' ? 'ticket' : 'predefined', q.key)}
              >
                <Text style={styles.quickText}>{q.text}</Text>
              </TouchableOpacity>
            ))}
          </ScrollView>

          <View style={styles.inputRow}>
            <TextInput
              style={styles.input}
              placeholder={languagePack.placeholder}
              value={message}
              onChangeText={setMessage}
            />
            <TouchableOpacity style={styles.send} onPress={() => send(message)}>
              <Text style={styles.sendText}>{sendMutation.isPending ? '...' : languagePack.send}</Text>
            </TouchableOpacity>
          </View>
        </View>
      </View>
    </AppModal>
  );
}

const styles = StyleSheet.create({
  wrap: { flex: 1, backgroundColor: 'rgba(0,0,0,0.35)', justifyContent: 'flex-end' },
  card: { backgroundColor: '#fff', borderTopLeftRadius: 18, borderTopRightRadius: 18, maxHeight: '86%', padding: 14 },
  head: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  headActions: { flexDirection: 'row', alignItems: 'center', gap: 10 },
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
  title: { fontSize: 18, fontWeight: '900', color: '#0f172a' },
  close: { color: '#1a73e8', fontWeight: '700' },
  history: { marginTop: 10, maxHeight: 380 },
  historyContent: { paddingBottom: 8 },
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
  bubble: { borderRadius: 12, padding: 10, marginTop: 6, maxWidth: '90%' },
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
  quickRow: { gap: 8, paddingVertical: 8 },
  quickBtn: { borderRadius: 999, borderWidth: 1, borderColor: '#dbeafe', backgroundColor: '#eff6ff', paddingVertical: 6, paddingHorizontal: 10 },
  quickText: { color: '#1d4ed8', fontSize: 12, fontWeight: '700' },
  inputRow: { flexDirection: 'row', gap: 8, alignItems: 'center', marginTop: 6 },
  input: { flex: 1, borderWidth: 1, borderColor: '#e2e8f0', borderRadius: 10, paddingHorizontal: 10, paddingVertical: 10, fontSize: 14 },
  send: { backgroundColor: '#1a73e8', borderRadius: 10, paddingHorizontal: 14, paddingVertical: 10 },
  sendText: { color: '#fff', fontWeight: '800' },
});

