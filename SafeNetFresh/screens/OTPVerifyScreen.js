import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  ActivityIndicator,
  Alert,
  Keyboard,
  KeyboardAvoidingView,
  Platform,
  TouchableWithoutFeedback,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { auth, workers } from '../services/api';
import { useAuth } from '../contexts/AuthContext';

const BRAND = '#1A56DB';

export default function OTPVerifyScreen({ navigation, route }) {
  const { phone } = route.params || {};
  const { signIn, dispatch, signOut } = useAuth();
  const insets = useSafeAreaInsets();

  const [digits, setDigits] = useState(['', '', '', '', '', '']);
  const [loading, setLoading] = useState(false);
  const [remain, setRemain] = useState(60);
  const [resending, setResending] = useState(false);
  const submittedCodeRef = useRef(null);
  const verifyInFlight = useRef(false);
  const inputsRef = useRef([]);

  // Simulate SMS autofill: after 1.3s auto-fill and submit
  useEffect(() => {
    const AUTOFILL = '123456';
    const t = setTimeout(() => {
      if (verifyInFlight.current) return;
      setDigits(AUTOFILL.split(''));
      submittedCodeRef.current = AUTOFILL;
      verifyWithCode(AUTOFILL);
    }, 1300);
    return () => clearTimeout(t);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (remain <= 0) return undefined;
    const id = setTimeout(() => setRemain((r) => r - 1), 1000);
    return () => clearTimeout(id);
  }, [remain]);

  const verifyWithCode = useCallback(
    async (code) => {
      Keyboard.dismiss();
      if (!phone) {
        Alert.alert('Error', 'Missing phone number');
        return;
      }
      if (code.length !== 6) return;

      if (verifyInFlight.current) return;
      verifyInFlight.current = true;
      setLoading(true);
      try {
        const data = await auth.verifyOTP(phone, code);
        await signIn({
          phone,
          access_token: data.access_token,
          refresh_token: data.refresh_token,
          user_id: data.user_id,
        });

        if (data.is_new_user) {
          navigation.replace('ProfileSetup');
          return;
        }

        try {
          const profile = await workers.getProfile();
          dispatch({ type: 'SET_PROFILE', profile });
        } catch (e) {
          const status = e?.response?.status;
          if (status === 401) {
            await signOut();
            navigation.replace('Onboarding');
            return;
          }
          if (status === 404) {
            dispatch({ type: 'SET_PROFILE_READY', ready: false });
            navigation.replace('ProfileSetup');
            return;
          }
          dispatch({ type: 'SET_PROFILE_READY', ready: false });
          navigation.replace('ProfileSetup');
        }
      } catch (e) {
        const msg = e?.response?.data?.detail;
        Alert.alert('Invalid OTP', typeof msg === 'string' ? msg : e?.message || 'Verification failed');
        submittedCodeRef.current = null;
        setDigits(['', '', '', '', '', '']);
        inputsRef.current[0]?.focus();
      } finally {
        verifyInFlight.current = false;
        setLoading(false);
      }
    },
    [phone, signIn, dispatch, navigation, signOut]
  );

  useEffect(() => {
    const code = digits.join('');
    if (code.length !== 6 || loading) return;
    if (submittedCodeRef.current === code) return;
    submittedCodeRef.current = code;
    verifyWithCode(code);
  }, [digits, loading, verifyWithCode]);

  const onChangeDigit = (text, index) => {
    const d = text.replace(/\D/g, '').slice(-1);
    setDigits((prev) => {
      const next = [...prev];
      next[index] = d;
      return next;
    });
    if (d && index < 5) {
      inputsRef.current[index + 1]?.focus();
    }
  };

  const onKeyPress = (e, index) => {
    if (e.nativeEvent.key === 'Backspace' && !digits[index] && index > 0) {
      inputsRef.current[index - 1]?.focus();
    }
  };

  const handleResend = async () => {
    if (remain > 0 || resending || !phone) return;
    setResending(true);
    try {
      await auth.sendOTP(phone);
      setRemain(60);
      submittedCodeRef.current = null;
    } catch (e) {
      Alert.alert('Error', e?.message || 'Could not resend OTP');
    } finally {
      setResending(false);
    }
  };

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      keyboardVerticalOffset={Platform.OS === 'ios' ? insets.top : 0}
    >
      <TouchableWithoutFeedback onPress={Keyboard.dismiss} accessible={false}>
        <View style={[styles.container, { paddingTop: insets.top + 12, paddingBottom: insets.bottom + 12 }]}>
          <Text style={styles.header}>Verify +91 {phone || '—'}</Text>
          <Text style={styles.sub}>Enter the 6-digit code</Text>

          <View style={styles.row}>
            {digits.map((d, i) => (
              <TextInput
                key={i}
                ref={(el) => {
                  inputsRef.current[i] = el;
                }}
                style={[styles.box, d ? styles.boxFilled : null]}
                keyboardType="number-pad"
                maxLength={1}
                value={d}
                onChangeText={(t) => onChangeDigit(t, i)}
                onKeyPress={(e) => onKeyPress(e, i)}
                editable={!loading}
                selectTextOnFocus
              />
            ))}
          </View>

          <TouchableOpacity
            style={[styles.btn, loading && styles.btnDisabled]}
            onPress={() => verifyWithCode(digits.join(''))}
            disabled={loading || digits.join('').length !== 6}
          >
            {loading ? <ActivityIndicator color="#fff" /> : <Text style={styles.btnText}>Verify and continue</Text>}
          </TouchableOpacity>

          <TouchableOpacity
            style={styles.resendWrap}
            onPress={handleResend}
            disabled={remain > 0 || resending || loading}
          >
            {remain > 0 ? (
              <Text style={styles.resendMuted}>Resend OTP in {remain}s</Text>
            ) : (
              <Text style={styles.resendActive}>{resending ? 'Sending…' : 'Resend OTP'}</Text>
            )}
          </TouchableOpacity>

          <TouchableOpacity style={styles.back} onPress={() => navigation.replace('Onboarding')} disabled={loading}>
            <Text style={styles.backText}>Change number</Text>
          </TouchableOpacity>
        </View>
      </TouchableWithoutFeedback>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#f8fafc', paddingHorizontal: 20 },
  header: { fontSize: 22, fontWeight: '800', color: '#111827' },
  demoHint: { marginTop: 8, fontSize: 13, color: BRAND, fontWeight: '700' },
  sub: { fontSize: 14, color: '#6b7280', marginTop: 8, marginBottom: 24 },
  row: { flexDirection: 'row', justifyContent: 'space-between', gap: 8 },
  box: {
    flex: 1,
    aspectRatio: 1,
    maxWidth: 52,
    borderWidth: 2,
    borderColor: '#e5e7eb',
    borderRadius: 12,
    textAlign: 'center',
    fontSize: 22,
    fontWeight: '800',
    color: '#111827',
    backgroundColor: '#fff',
  },
  boxFilled: { borderColor: BRAND, backgroundColor: '#eff6ff' },
  btn: {
    backgroundColor: BRAND,
    borderRadius: 14,
    paddingVertical: 16,
    alignItems: 'center',
    marginTop: 28,
  },
  btnDisabled: { opacity: 0.7 },
  btnText: { color: '#fff', fontSize: 17, fontWeight: '800' },
  resendWrap: { marginTop: 20, alignItems: 'center' },
  resendMuted: { color: '#9ca3af', fontSize: 14 },
  resendActive: { color: BRAND, fontSize: 15, fontWeight: '700' },
  back: { marginTop: 24, alignItems: 'center' },
  backText: { color: BRAND, fontSize: 14, fontWeight: '600' },
});
