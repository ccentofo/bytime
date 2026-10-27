import {
  IconAlertCircle, IconAlertTriangle, IconArrowsExchange, IconBan, IconBell, IconBriefcase, IconCalendarX, IconCash,
  IconChartBar, IconCheck, IconChevronDown, IconChevronRight, IconClock, IconCopy, IconCurrencyDollar, IconDots,
  IconDownload, IconEdit, IconEye, IconHistory, IconInfoCircle, IconKey, IconKeyOff, IconList, IconLock, IconLockOpen,
  IconLogout, IconMoon, IconPassword, IconPencil, IconPlus, IconReceipt, IconRefresh, IconReportMoney, IconRestore,
  IconScale, IconSearch, IconSun, IconTrash, IconUpload, IconUser, IconUsers, IconWand, IconX,
} from '@tabler/icons-react';

/**
 * The icon registry (feature-plan-ux-foundations.md §4.3, UX-AUDIT §4.2): ONE entry per meaning. Import icons from
 * here, never from '@tabler/icons-react' directly (the ratchet test icon-registry.test.ts allows only icons.ts and a
 * shrinking allowlist). Two keys may share a component only when listed in ICON_ALIASES.
 */
export const Icons = {
  // Row and record actions
  create: IconPlus,
  edit: IconPencil,
  delete: IconTrash,
  deactivate: IconBan,
  reactivate: IconRestore,
  moreActions: IconDots,
  rates: IconCurrencyDollar,
  laborCategory: IconBriefcase,
  history: IconHistory,
  resetPassword: IconPassword,
  unlock: IconLockOpen,
  flsa: IconScale,
  manageClins: IconList,
  revokeKey: IconKeyOff,
  endAssignment: IconCalendarX,
  apiKey: IconKey,

  // General actions
  search: IconSearch,
  download: IconDownload,
  upload: IconUpload,
  view: IconEye,
  copy: IconCopy,
  approve: IconCheck,
  reject: IconX,
  automate: IconWand,
  sync: IconArrowsExchange,
  refresh: IconRefresh,
  expand: IconChevronRight,
  collapse: IconChevronDown,

  // Status
  statusError: IconAlertCircle,
  statusWarning: IconAlertTriangle,
  statusInfo: IconInfoCircle,
  statusSuccess: IconCheck,

  // Records and figures
  timeEntry: IconClock,
  correction: IconEdit,
  users: IconUsers,
  contracts: IconReportMoney,
  funded: IconCash,
  spent: IconReceipt,
  remaining: IconChartBar,

  // Shell
  profile: IconUser,
  changePassword: IconLock,
  notifications: IconBell,
  signOut: IconLogout,
  themeLight: IconSun,
  themeDark: IconMoon,
} as const;

export type IconKey = keyof typeof Icons;

/** Icon sizes: one scale. */
export const ICON_SIZE = { menu: 16, button: 16, nav: 18, stat: 20 } as const;

/** Key pairs that deliberately share an icon, each with its reason. Any other shared component fails the test. */
export const ICON_ALIASES: ReadonlyArray<{ keys: readonly [IconKey, IconKey]; reason: string }> = [
  { keys: ['approve', 'statusSuccess'], reason: 'A check means "done / OK" both as an action (approve) and as a status.' },
];
