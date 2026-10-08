import type { CapacitorConfig } from '@capacitor/cli'

const config: CapacitorConfig = {
  appId: 'jp.ashiato.album',
  appName: 'ashiato',
  webDir: 'dist',
  ios: {
    contentInset: 'automatic',
  },
  android: {
    useLegacyBridge: true,
  },
}

export default config
