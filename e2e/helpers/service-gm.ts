/**
 * The platform's headless service-GM, mirrored for the standalone e2e. The id
 * matches SERVICE_GM_NATIVE_ID in cfg-core-server (admin-key.ts). The password is
 * a KNOWN test value: the e2e controls BOTH the on-disk doc and the /join, so it
 * proves the Foundry mechanic (a role-4 credential SSOs in) without needing
 * core's CORE_SECRET-derived password.
 */
export const SERVICE_GM = {
  nativeUserId: 'CFGServiceGM0000', // 16-char [A-Za-z0-9], == SERVICE_GM_NATIVE_ID
  name: 'Crit-Fumble Service',
  role: 4, // GAMEMASTER
  password: 'e2e-service-gm-password',
  coreUserId: 'system-foundry-service-gm',
} as const
