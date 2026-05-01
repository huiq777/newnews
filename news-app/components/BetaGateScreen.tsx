// BetaGateScreen — full-screen Round 1 closed-beta auth gate.
// Spec: docs/superpowers/specs/2026-04-26-beta-auth-gate-design.md §4b

import { useMemo } from 'react'
import { ActivityIndicator, Platform, Pressable, StyleSheet, Text, View } from 'react-native'
import type { GateStatus, RedeemError } from '../lib/auth'
import { getDeviceLang } from '../lib/config'

type Lang = 'en' | 'zh'

type Strings = {
  brand: string
  beta: string
  loading: string
  redeeming: string
  gatedBody: string
  redeemFailedTitle: string
  reasons: Record<Exclude<RedeemError, null>, string>
  tryAgain: string
  mobileGatedNoInvite: string
  mobileGatedWithInvite: string
}

const STRINGS: Record<Lang, Strings> = {
  en: {
    brand: 'Newnews',
    beta: 'Closed Beta',
    loading: 'Loading…',
    redeeming: 'Redeeming invite…',
    gatedBody: 'This is an invite-only beta. Ask Jin for an invite link.',
    redeemFailedTitle: "Invite link couldn't be used",
    reasons: {
      invalid: 'Invite code not recognized. Ask Jin for a fresh link.',
      used: 'This invite was already used. Ask Jin for a fresh link.',
      expired: 'This invite has expired. Ask Jin for a fresh link.',
      network: "Network error. Your spot is held — tap retry.",
    },
    tryAgain: 'Try again',
    mobileGatedNoInvite: 'This is an invite-only beta. Please open this on a computer to get started.',
    mobileGatedWithInvite: 'Please open this invite link on a computer to redeem it and access the beta.',
  },
  zh: {
    brand: 'Newnews',
    beta: '内测',
    loading: '加载中…',
    redeeming: '正在验证邀请…',
    gatedBody: '本应用处于受邀内测中，请向 Jin 索取邀请链接。',
    redeemFailedTitle: '邀请链接无法使用',
    reasons: {
      invalid: '未识别的邀请码。请向 Jin 索取新的链接。',
      used: '此邀请已被使用。请向 Jin 索取新的链接。',
      expired: '此邀请已过期。请向 Jin 索取新的链接。',
      network: '网络异常。你的进度已保留，请点击重试。',
    },
    tryAgain: '重试',
    mobileGatedNoInvite: '本应用处于受邀内测中，请在电脑上打开。',
    mobileGatedWithInvite: '请在电脑上打开此邀请链接以兑换内测资格。',
  },
}

type Props = {
  status: Exclude<GateStatus, 'authed'>
  redeemError: RedeemError
  onRetry: () => void
}

export default function BetaGateScreen({ status, redeemError, onRetry }: Props) {
  const lang = useMemo(getDeviceLang, [])
  const t = STRINGS[lang]

  const renderBody = () => {
    if (status === 'checking' || status === 'redeeming') {
      return (
        <>
          <ActivityIndicator color="#1A1A1A" />
          <Text style={styles.label}>{status === 'checking' ? t.loading : t.redeeming}</Text>
        </>
      )
    }
    if (status === 'gated') {
      return (
        <>
          <Text style={styles.headline}>{t.beta}</Text>
          <Text style={styles.bodyText}>{t.gatedBody}</Text>
        </>
      )
    }
    if (status === 'desktop_required_no_invite' || status === 'desktop_required_with_invite') {
      return (
        <>
          <Text style={styles.headline}>{t.beta}</Text>
          <Text style={styles.bodyText}>
            {status === 'desktop_required_with_invite' ? t.mobileGatedWithInvite : t.mobileGatedNoInvite}
          </Text>
        </>
      )
    }
    // redeem_failed
    const reason: Exclude<RedeemError, null> = redeemError ?? 'invalid'
    return (
      <>
        <Text style={styles.headline}>{t.redeemFailedTitle}</Text>
        <Text style={styles.bodyText}>{t.reasons[reason]}</Text>
        {reason === 'network' && (
          <Pressable onPress={onRetry} style={styles.retryBtn}>
            <Text style={styles.retryText}>{t.tryAgain}</Text>
          </Pressable>
        )}
      </>
    )
  }

  return (
    <View style={styles.container}>
      <View style={styles.card}>
        <Text style={styles.brand}>{t.brand}</Text>
        {renderBody()}
      </View>
    </View>
  )
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#F7F6F2',
    padding: 32,
  },
  card: {
    maxWidth: 420,
    alignItems: 'center',
    gap: 16,
  },
  brand: {
    fontFamily: 'Space Grotesk, sans-serif',
    fontSize: 28,
    fontWeight: '700',
    color: '#1A1A1A',
    letterSpacing: -0.5,
  },
  headline: {
    fontFamily: 'Space Grotesk, sans-serif',
    fontSize: 18,
    fontWeight: '600',
    color: '#1A1A1A',
    textAlign: 'center',
    marginTop: 8,
  },
  bodyText: {
    fontFamily: 'Manrope, sans-serif',
    fontSize: 14,
    color: '#4A4A4A',
    textAlign: 'center',
    lineHeight: 22,
  },
  label: {
    fontFamily: 'Manrope, sans-serif',
    fontSize: 13,
    color: '#6B6B6B',
    marginTop: 8,
  },
  retryBtn: {
    marginTop: 12,
    paddingHorizontal: 24,
    paddingVertical: 10,
    backgroundColor: '#1A1A1A',
    borderRadius: 999,
  },
  retryText: {
    fontFamily: 'Manrope, sans-serif',
    fontSize: 14,
    fontWeight: '600',
    color: '#FFFFFF',
  },
})
