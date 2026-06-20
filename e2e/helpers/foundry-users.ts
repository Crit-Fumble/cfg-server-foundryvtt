import { ClassicLevel } from 'classic-level'
import { pbkdf2Sync, randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Offline writer for a world's `users/` LevelDB — the standalone-e2e mirror of
 * cfg-core-server's foundry-users-store.createFoundryUser. CFG manages Foundry
 * users by writing the on-disk doc directly (works while the world is offline);
 * the doc shape + password hash must match Foundry's, or /join rejects it.
 */

const userKey = (id: string) => `!users!${id}`

/** PBKDF2-SHA512, 1000 iters, 64-byte key, hex — Foundry v14 hashPassword(). */
function hashFoundryPassword(password: string, salt: string): string {
  return pbkdf2Sync(password, salt, 1000, 64, 'sha512').toString('hex')
}

/** `<e2e-data>/Data/worlds/<worldId>/data/users` — Foundry's per-world users store. */
export function resolveUsersDir(e2eDataDir: string, worldId: string): string {
  return join(e2eDataDir, 'Data', 'worlds', worldId, 'data', 'users')
}

export interface SeedUser {
  nativeUserId: string // 16-char [A-Za-z0-9]
  name: string
  role: number // 4 = GAMEMASTER
  password: string
  coreUserId?: string
}

/**
 * Write (or re-password) a Foundry User doc directly into the world's users
 * LevelDB while the world is OFFLINE — same on-disk shape createFoundryUser
 * produces, so Foundry accepts it and /join validates the password. MUST run
 * before the world is launched (Foundry holds users/LOCK once active).
 * Idempotent: an existing doc keeps its other fields, re-asserting role + a
 * fresh password hash.
 */
export async function seedFoundryUser(usersDir: string, input: SeedUser): Promise<void> {
  if (!existsSync(usersDir)) throw new Error(`world users dir missing: ${usersDir}`)
  if (!/^[A-Za-z0-9]{16}$/.test(input.nativeUserId)) {
    throw new Error(`Foundry _id must be 16-char [A-Za-z0-9]: ${input.nativeUserId}`)
  }
  const db = new ClassicLevel<string, Record<string, unknown>>(usersDir, { valueEncoding: 'json' })
  await db.open()
  try {
    const key = userKey(input.nativeUserId)
    const existing = await db
      .get(key)
      .catch((e: { code?: string }) => (e?.code === 'LEVEL_NOT_FOUND' ? undefined : Promise.reject(e)))
    const now = Date.now()
    const base: Record<string, unknown> = existing ?? {
      _id: input.nativeUserId,
      avatar: null,
      character: null,
      color: '#66cc28',
      pronouns: '',
      hotbar: {},
      permissions: {},
      flags: input.coreUserId ? { 'crit-fumble-core': { coreUserId: input.coreUserId } } : {},
      _stats: {
        coreVersion: null,
        systemId: null,
        systemVersion: null,
        createdTime: now,
        modifiedTime: now,
        lastModifiedBy: null,
        compendiumSource: null,
        duplicateSource: null,
        exportSource: null,
      },
    }
    const salt = randomBytes(64).toString('hex').slice(0, 64)
    const doc: Record<string, unknown> = {
      ...base,
      _id: input.nativeUserId,
      name: input.name,
      role: input.role,
      password: hashFoundryPassword(input.password, salt),
      passwordSalt: salt,
    }
    await db.put(key, doc)
  } finally {
    await db.close()
  }
}
