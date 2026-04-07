import React, { useMemo } from 'react';
import { ActivityIndicator, RefreshControl, ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { notifications } from '../services/api';
import { useAuth } from '../contexts/AuthContext';

const ICON = {
  payout: '✅',
  admin_reply: '💬',
  alert: '🌧️',
  system: '⚠️',
};

export default function NotificationsScreen() {
  const { userId } = useAuth();
  const insets = useSafeAreaInsets();
  const qc = useQueryClient();
  const query = useQuery({
    queryKey: ['notifications', userId],
    queryFn: () => notifications.list(String(userId || '')),
    enabled: Boolean(userId),
    refetchInterval: 12000,
  });

  const markRead = useMutation({
    mutationFn: (id) => notifications.markRead(id),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['notifications', userId] }),
  });
  const markAll = useMutation({
    mutationFn: () => notifications.markAllRead(),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['notifications', userId] }),
  });

  const items = useMemo(() => query.data?.data || [], [query.data]);
  const unread = Number(query.data?.unread_count || 0);

  return (
    <ScrollView
      style={styles.root}
      contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + 28 }]}
      refreshControl={<RefreshControl refreshing={Boolean(query.isRefetching)} onRefresh={() => void query.refetch()} />}
    >
      <View style={styles.head}>
        <View>
          <Text style={styles.title}>Notifications</Text>
          <Text style={styles.sub}>{unread} unread</Text>
        </View>
        <TouchableOpacity style={styles.markBtn} onPress={() => markAll.mutate()} disabled={markAll.isPending}>
          <Text style={styles.markText}>Mark all read</Text>
        </TouchableOpacity>
      </View>
      {query.isLoading ? (
        <ActivityIndicator color="#1a73e8" />
      ) : items.length === 0 ? (
        <Text style={styles.empty}>No notifications yet.</Text>
      ) : (
        items.map((n) => (
          <TouchableOpacity
            key={String(n.id)}
            style={[styles.row, !n.is_read && styles.rowUnread]}
            onPress={() => {
              if (!n.is_read) markRead.mutate(n.id);
            }}
          >
            <Text style={styles.icon}>{ICON[n.type] || '🔔'}</Text>
            <View style={{ flex: 1 }}>
              <Text style={styles.rTitle}>{n.title}</Text>
              <Text style={styles.rMsg}>{n.message}</Text>
            </View>
          </TouchableOpacity>
        ))
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#f0f4ff' },
  content: { padding: 18 },
  head: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 },
  title: { fontSize: 24, fontWeight: '900', color: '#0f172a' },
  sub: { color: '#64748b', marginTop: 4, fontWeight: '600' },
  markBtn: { borderWidth: 1, borderColor: '#bfdbfe', backgroundColor: '#eff6ff', borderRadius: 10, paddingHorizontal: 10, paddingVertical: 8 },
  markText: { color: '#1d4ed8', fontWeight: '800', fontSize: 12 },
  empty: { color: '#64748b', fontWeight: '600', marginTop: 10 },
  row: { backgroundColor: '#fff', borderRadius: 14, borderWidth: 1, borderColor: 'rgba(0,0,0,0.06)', padding: 12, marginBottom: 10, flexDirection: 'row', gap: 10, alignItems: 'flex-start' },
  rowUnread: { borderColor: '#93c5fd', backgroundColor: '#f8fbff' },
  icon: { fontSize: 20, marginTop: 1 },
  rTitle: { fontWeight: '800', color: '#0f172a', fontSize: 14 },
  rMsg: { marginTop: 4, color: '#475569', fontSize: 13, lineHeight: 18 },
});

