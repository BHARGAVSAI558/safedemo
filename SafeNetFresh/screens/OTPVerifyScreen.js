import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  Pressable,
  StyleSheet,
  ActivityIndicator,
  Alert,
  Keyboard,
  KeyboardAvoidingView,
  Platform,
} from 'react-native';
import Constants from 'expo-constants';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { auth, workers } from '../services/api';
import { useAuth } from '../contexts/AuthContext';

const BRAND = '#1A56DB';
const SMS_AUTOFILL_MS = 3500;

const isWeb = Platform.OS === 'web';

/**
 * Demo OTP UX: random 6-digit auto-fill + submit (matches backend DEMO_MODE accepting any 6 digits).
 * - app.json `expo.extra.DEMO_MODE: true` (default for your QR / EAS builds)
 * - or EAS env `EXPO_PUBLIC_DEMO_OTP=1` at build time
 */
function isClientDemoOtpEnabled() {
  try {
    const pub = typeof process !== 'undefined' && process.env?.EXPO_PUBLIC_DEMO_OTP;
    if (pub === '1' || pub === 'true') return true;
  } catch (_) {
    /* ignore */
  }
  const v = Constants.expoConfig?.extra?.DEMO_MODE ?? Constants.expo?.extra?.DEMO_MODE;
  return v === true || v === 'true';
}

function randomSixDigitOtp() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

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
  const demoOtpRef = useRef(randomSixDigitOtp());
  const digitsRef = useRef('');
  const demoAuto = isClientDemoOtpEnabled();

  useEffect(() => {
    digitsRef.current = digits.join('');
  }, [digits]);

  // Demo: after send-otp, auto-fill a random 6-digit code and verify (requires API DEMO_MODE).
  useEffect(() => {
    if (!demoAuto) return undefined;
    const code = demoOtpRef.current;
    const t = setTimeout(() => {
      if (verifyInFlight.current || digitsRef.current.length > 0) return;
      setDigits(code.split(''));
      submittedCodeRef.current = code;
      verifyWithCode(code);
    }, SMS_AUTOFILL_MS);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [demoAuto]);

  useEffect(() => {
    if (!isWeb) return undefined;
    const t = setTimeout(() => inputsRef.current[0]?.focus(), 200);
    return () => clearTimeout(t);
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
          if (profile?.is_profile_complete === false) {
            navigation.replace('ProfileSetup');
            return;
          }
          // profileReady true → RootNavigator swaps to MainTabs (no named route on this stack)
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
    const cleaned = text.replace(/\D/g, '');
    // Web: paste or IME can send several digits at once into one field
    if (cleaned.length > 1) {
      const chars = cleaned.slice(0, 6).split('');
      setDigits((prev) => {
        const next = [...prev];
        for (let j = 0; j < chars.length && index + j < 6; j += 1) {
          next[index + j] = chars[j];
        }
        return next;
      });
      const nextFocus = Math.min(index + chars.length, 5);
      setTimeout(() => inputsRef.current[nextFocus]?.focus(), 0);
      return;
    }
    const d = cleaned.slice(-1);
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
    const key = e?.nativeEvent?.key ?? '';
    const isBackspace = key === 'Backspace' || key === 'Delete';
    if (isBackspace && !digits[index] && index > 0) {
      inputsRef.current[index - 1]?.focus();
    }
  };

  const handleResend = async () => {
    if (remain > 0 || resending || !phone) return;
    setResending(true);
    try {
      await auth.sendOTP(phone);
      demoOtpRef.current = randomSixDigitOtp();
      setRemain(60);
      submittedCodeRef.current = null;
      setDigits(['', '', '', '', '', '']);
      if (demoAuto) {
        const code = demoOtpRef.current;
        setTimeout(() => {
          if (verifyInFlight.current || digitsRef.current.length > 0) return;
          setDigits(code.split(''));
          submittedCodeRef.current = code;
          verifyWithCode(code);
        }, SMS_AUTOFILL_MS);
      }
      if (isWeb) setTimeout(() => inputsRef.current[0]?.focus(), 0);
    } catch (e) {
      Alert.alert('Error', e?.message || 'Could not resend OTP');
    } finally {
      setResending(false);
    }
  };

  const padStyle = [styles.container, { paddingTop: insets.top + 12, paddingBottom: insets.bottom + 12 }];

  const formBody = (
    <>
      <Text style={styles.kicker}>Verification</Text>
      <Text style={styles.header}>+91 {phone || '—'}</Text>
      <Text style={styles.sub}>We sent a 6-digit code to this number</Text>
      <Text style={styles.subMuted}>
        {demoAuto
          ? isWeb
            ? 'Auto-fills a random code in ~3–4s, or type any 6 digits.'
            : 'Auto-fills in ~3–4s, or enter any 6 digits below.'
          : isWeb
            ? 'Type or paste the 6-digit code from your SMS (check spam folder).'
            : 'Enter the 6-digit code from your SMS.'}
      </Text>

      {isWeb ? (
        <TextInput
          ref={(el) => {
            inputsRef.current[0] = el;
          }}
          style={styles.webOtpInput}
          keyboardType="default"
          inputMode="numeric"
          maxLength={6}
          value={digits.join('')}
          onChangeText={(t) => {
            const c = t.replace(/\D/g, '').slice(0, 6);
            const next = ['', '', '', '', '', ''];
            for (let i = 0; i < c.length; i += 1) next[i] = c[i];
            setDigits(next);
          }}
          editable={!loading}
          autoComplete="one-time-code"
          autoCorrect={false}
          autoCapitalize="none"
          spellCheck={false}
          nativeID="safenet-otp"
          autoFocus
        />
      ) : (
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
              textContentType="oneTimeCode"
              autoComplete="sms-otp"
            />
          ))}
        </View>
      )}

      <TouchableOpacity
        style={[styles.btn, loading && styles.btnDisabled]}
        onPress={() => verifyWithCode(digits.join(''))}
        disabled={loading || digits.join('').length !== 6}
      >
        {loading ? <ActivityIndicator color="#fff" /> : <Text style={styles.btnText}>Verify & Login</Text>}
      </TouchableOpacity>

      <TouchableOpacity
        style={styles.resendWrap}
        onPress={handleResend}
        disabled={remain > 0 || resending || loading}
      >
        {remain > 0 ? (
          <Text style={styles.resendMuted}>Resend code in {remain}s</Text>
        ) : (
          <Text style={styles.resendActive}>{resending ? 'Sending…' : 'Resend code'}</Text>
        )}
      </TouchableOpacity>

      <TouchableOpacity style={styles.back} onPress={() => navigation.replace('Onboarding')} disabled={loading}>
        <Text style={styles.backText}>Change number</Text>
      </TouchableOpacity>
    </>
  );

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      keyboardVerticalOffset={Platform.OS === 'ios' ? insets.top : 0}
    >
      {isWeb ? (
        <View style={padStyle}>{formBody}</View>
      ) : (
        <Pressable style={padStyle} onPress={Keyboard.dismiss} accessible={false}>
          {formBody}
        </Pressable>
      )}
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#f8fafc', paddingHorizontal: 20 },
  kicker: {
    fontSize: 13,
    fontWeight: '700',
    color: BRAND,
    textTransform: 'uppercase',
    letterSpacing: 0.8,
    marginBottom: 6,
  },
  header: { fontSize: 26, fontWeight: '800', color: '#111827', letterSpacing: -0.3 },
  demoHint: { marginTop: 8, fontSize: 13, color: BRAND, fontWeight: '700' },
  sub: { fontSize: 15, color: '#374151', marginTop: 10, fontWeight: '600', lineHeight: 22 },
  subMuted: { fontSize: 14, color: '#6b7280', marginTop: 6, marginBottom: 20 },
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
  webOtpInput: {
    alignSelf: 'center',
    width: '100%',
    maxWidth: 280,
    borderWidth: 2,
    borderColor: '#e5e7eb',
    borderRadius: 14,
    paddingVertical: 16,
    paddingHorizontal: 12,
    fontSize: 24,
    fontWeight: '800',
    letterSpacing: 8,
    textAlign: 'center',
    color: '#111827',
    backgroundColor: '#fff',
    marginTop: 4,
    fontFamily: Platform.select({ web: 'SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace', default: undefined }),
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
