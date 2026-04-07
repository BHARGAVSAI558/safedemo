import React, { useMemo, useState } from 'react';
import { ActivityIndicator, ScrollView, StyleSheet, Text, TextInput, TouchableOpacity, View } from 'react-native';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import AppModal from './AppModal';
import { support } from '../services/api';
import { useAuth } from '../contexts/AuthContext';

const QUICK_ACTIONS = [
  'Why no payout?',
  'Claim still under review',
  'Need help with coverage plan',
  'How is payout calculated?',
];

export default function AssistantModal({ visible, onClose }) {
  const { userId } = useAuth();
  const qc = useQueryClient();
  const [message, setMessage] = useState('');

  const historyQuery = useQuery({
    queryKey: ['supportHistory', userId],
    queryFn: () => support.history(userId),
    enabled: visible && Boolean(userId),
    staleTime: 10_000,
  });

  const sendMutation = useMutation({
    mutationFn: ({ text, type }) =>
      support.query({ user_id: String(userId || ''), message: text, type }),
    onSuccess: () => {
      setMessage('');
      void qc.invalidateQueries({ queryKey: ['supportHistory', userId] });
    },
  });

  const items = useMemo(() => (Array.isArray(historyQuery.data) ? historyQuery.data : []), [historyQuery.data]);

  const send = (text, type = 'custom') => {
    const trimmed = String(text || '').trim();
    if (!trimmed || sendMutation.isPending) return;
    sendMutation.mutate({ text: trimmed, type });
  };

  return (
    <AppModal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
      <View style={styles.wrap}>
        <View style={styles.card}>
          <View style={styles.head}>
            <Text style={styles.title}>Support Assistant</Text>
            <TouchableOpacity onPress={onClose}>
              <Text style={styles.close}>Close</Text>
            </TouchableOpacity>
          </View>

          <ScrollView style={styles.history} contentContainerStyle={styles.historyContent}>
            {historyQuery.isLoading ? (
              <ActivityIndicator color="#1a73e8" />
            ) : items.length === 0 ? (
              <Text style={styles.empty}>Ask a question. Support and admin replies will appear here.</Text>
            ) : (
              items.map((row) => (
                <View key={String(row.id)} style={{ marginBottom: 12 }}>
                  <View style={[styles.bubble, styles.userBubble]}>
                    <Text style={styles.userText}>{row.message}</Text>
                  </View>
                  <View style={[styles.bubble, styles.systemBubble]}>
                    <Text style={styles.sysLabel}>System</Text>
                    <Text style={styles.sysText}>{row.reply}</Text>
                  </View>
                  {row.admin_reply ? (
                    <View style={[styles.bubble, styles.adminBubble]}>
                      <Text style={styles.adminLabel}>Admin</Text>
                      <Text style={styles.adminText}>{row.admin_reply}</Text>
                    </View>
                  ) : null}
                </View>
              ))
            )}
          </ScrollView>

          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.quickRow}>
            {QUICK_ACTIONS.map((q) => (
              <TouchableOpacity key={q} style={styles.quickBtn} onPress={() => send(q, 'predefined')}>
                <Text style={styles.quickText}>{q}</Text>
              </TouchableOpacity>
            ))}
          </ScrollView>

          <View style={styles.inputRow}>
            <TextInput
              style={styles.input}
              placeholder="Type your message..."
              value={message}
              onChangeText={setMessage}
            />
            <TouchableOpacity style={styles.send} onPress={() => send(message)}>
              <Text style={styles.sendText}>{sendMutation.isPending ? '...' : 'Send'}</Text>
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
  title: { fontSize: 18, fontWeight: '900', color: '#0f172a' },
  close: { color: '#1a73e8', fontWeight: '700' },
  history: { marginTop: 10, maxHeight: 380 },
  historyContent: { paddingBottom: 8 },
  empty: { color: '#64748b', fontSize: 13 },
  bubble: { borderRadius: 12, padding: 10, marginTop: 6, maxWidth: '90%' },
  userBubble: { alignSelf: 'flex-end', backgroundColor: '#1a73e8' },
  userText: { color: '#fff', fontWeight: '700' },
  systemBubble: { alignSelf: 'flex-start', backgroundColor: '#f1f5f9', borderWidth: 1, borderColor: '#e2e8f0' },
  sysLabel: { fontSize: 10, fontWeight: '900', color: '#475569', marginBottom: 4, textTransform: 'uppercase' },
  sysText: { color: '#0f172a', fontSize: 13 },
  adminBubble: { alignSelf: 'flex-start', backgroundColor: '#ecfeff', borderWidth: 1, borderColor: '#bae6fd' },
  adminLabel: { fontSize: 10, fontWeight: '900', color: '#0c4a6e', marginBottom: 4, textTransform: 'uppercase' },
  adminText: { color: '#0f172a', fontSize: 13, fontWeight: '700' },
  quickRow: { gap: 8, paddingVertical: 8 },
  quickBtn: { borderRadius: 999, borderWidth: 1, borderColor: '#dbeafe', backgroundColor: '#eff6ff', paddingVertical: 6, paddingHorizontal: 10 },
  quickText: { color: '#1d4ed8', fontSize: 12, fontWeight: '700' },
  inputRow: { flexDirection: 'row', gap: 8, alignItems: 'center', marginTop: 6 },
  input: { flex: 1, borderWidth: 1, borderColor: '#e2e8f0', borderRadius: 10, paddingHorizontal: 10, paddingVertical: 10, fontSize: 14 },
  send: { backgroundColor: '#1a73e8', borderRadius: 10, paddingHorizontal: 14, paddingVertical: 10 },
  sendText: { color: '#fff', fontWeight: '800' },
});

