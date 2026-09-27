import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'asia.wuxianzhi.ironhorse',
  appName: '铁马驿站排班中心',
  plugins: {
    SystemBars: {
      insetsHandling: 'css',
      initialViewportFitValueHint: 'cover',
    },
  },
  webDir: 'mobile-shell',
  server: {
    url: 'https://39.105.143.3',
    cleartext: false,
    allowNavigation: ['39.105.143.3'],
  },
};

export default config;
