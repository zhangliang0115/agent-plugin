/** Ant Design theme for the admin: dark-first, indigo accent, compact console density. */
import { theme, type ThemeConfig } from 'antd';

export type AdminTheme = 'dark' | 'light';

const shared: ThemeConfig = {
  token: {
    borderRadius: 8,
    borderRadiusLG: 12,
    fontFamily:
      '-apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Noto Sans SC", system-ui, sans-serif',
    fontSize: 13,
    colorPrimary: '#6366f1',
    colorInfo: '#38bdf8',
    colorSuccess: '#34d399',
    colorWarning: '#fbbf24',
    colorError: '#f87171',
    controlHeight: 32,
    wireframe: false,
  },
  components: {
    Layout: { headerHeight: 56, headerPadding: '0 22px', siderBg: 'transparent', bodyBg: 'transparent' },
    Menu: { itemHeight: 32, itemBorderRadius: 7, itemMarginInline: 0 },
    Table: { headerBg: 'transparent', rowHoverBg: 'rgba(99,102,241,0.07)', cellPaddingBlockSM: 7, cellPaddingInlineSM: 12 },
    Card: { headerHeight: 44 },
    Tabs: { horizontalItemPadding: '7px 0' },
  },
};

export function adminTheme(mode: AdminTheme): ThemeConfig {
  return {
    ...shared,
    algorithm: mode === 'dark' ? theme.darkAlgorithm : theme.defaultAlgorithm,
    token: {
      ...shared.token,
      colorPrimary: mode === 'dark' ? '#6366f1' : '#4f46e5',
      colorBgLayout: mode === 'dark' ? '#0a0b10' : '#f5f6fa',
      colorBgContainer: mode === 'dark' ? '#12141b' : '#ffffff',
      colorBorderSecondary: mode === 'dark' ? 'rgba(255,255,255,0.08)' : 'rgba(15,23,42,0.09)',
    },
  };
}
