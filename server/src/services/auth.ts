import { config } from '../config.js';
import type { Db } from '../db/pool.js';
import { generateToken, sha256 } from '../domain/reference.js';
import { decryptSecret, encryptSecret, hashPassword, verifyPassword } from '../lib/crypto.js';
import { badRequest, conflict, notFound, unauthorized } from '../lib/errors.js';
import { audit, type ActorContext } from './audit.js';
import { generateSecret, matchTotpStep, otpauthUrl } from './totp.js';

export type Role = 'owner' | 'operator' | 'viewer';

export interface AdminUser {
  id: string;
  email: string;
  name: string;
  password_hash: string;
  role: Role;
  mfa_secret: string | null;
  mfa_enabled: boolean;
  mfa_last_step: string | null;
  failed_logins: number;
  locked_until: Date | null;
  active: boolean;
  last_login_at: Date | null;
}

export interface SessionInfo {
  sessionId: string;
  mfaVerified: boolean;
  user: Pick<AdminUser, 'id' | 'email' | 'name' | 'role' | 'mfa_enabled'>;
}

/** Roles: viewer = read-only; operator = process orders; owner = also settings, fees, users. */
export const PERMISSIONS = {
  'orders.read': ['owner', 'operator', 'viewer'],
  'orders.write': ['owner', 'operator'],
  'settings.write': ['owner'],
  'users.manage': ['owner'],
  'rates.write': ['owner', 'operator'],
} as const satisfies Record<string, readonly Role[]>;
export type Permission = keyof typeof PERMISSIONS;

export function can(role: Role, permission: Permission): boolean {
  return (PERMISSIONS[permission] as readonly Role[]).includes(role);
}

const MAX_FAILED = 5;
const LOCK_MINUTES = 15;

export function actorFor(s: SessionInfo, ip?: string | null): ActorContext {
  return { type: 'admin', id: s.user.id, label: `${s.user.name} <${s.user.email}>`, ip };
}

export async function createAdminUser(db: Db, params: { email: string; name: string; password: string; role: Role }, actor?: ActorContext) {
  if (params.password.length < 12) throw badRequest('weak_password', 'Password must be at least 12 characters.');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(params.email)) throw badRequest('invalid_email', 'Invalid email.');
  const hash = await hashPassword(params.password);
  try {
    const { rows } = await db.query<AdminUser>(
      `INSERT INTO admin_users (email, name, password_hash, role) VALUES (lower($1), $2, $3, $4) RETURNING *`,
      [params.email, params.name, hash, params.role],
    );
    await audit(db, actor ?? { type: 'system', label: 'cli' }, {
      action: 'user.create',
      entityType: 'admin_user',
      entityId: rows[0].id,
      after: { email: rows[0].email, name: rows[0].name, role: rows[0].role },
    });
    return rows[0];
  } catch (err) {
    if ((err as { code?: string }).code === '23505') throw conflict('email_taken', 'A user with that email already exists.');
    throw err;
  }
}

/** Creates the first owner from config when no operator exists yet. Never touches existing users. */
export async function bootstrapOwner(db: Db, email: string, password: string): Promise<boolean> {
  if (!email || !password) return false;
  const { rows } = await db.query<{ n: string }>('SELECT count(*) AS n FROM admin_users');
  if (Number(rows[0].n) > 0) return false;
  await createAdminUser(db, { email, name: 'Owner', password, role: 'owner' }, { type: 'system', label: 'bootstrap' });
  return true;
}

export async function login(db: Db, email: string, password: string, meta: { ip?: string; userAgent?: string }) {
  const { rows } = await db.query<AdminUser>('SELECT * FROM admin_users WHERE email = lower($1)', [email]);
  const user = rows[0];
  const fail = unauthorized('Invalid email or password.');
  if (!user || !user.active) {
    // Spend comparable time so response timing does not reveal valid emails.
    await hashPassword(password);
    throw fail;
  }
  if (user.locked_until && new Date(user.locked_until) > new Date()) throw unauthorized('Account temporarily locked. Try again later.');
  if (!(await verifyPassword(password, user.password_hash))) {
    const failed = user.failed_logins + 1;
    const lock = failed >= MAX_FAILED;
    await db.query(
      `UPDATE admin_users SET failed_logins = $2::int,
         locked_until = CASE WHEN $3::boolean THEN now() + make_interval(mins => $4::int) ELSE locked_until END
       WHERE id = $1`,
      [user.id, lock ? 0 : failed, lock, LOCK_MINUTES],
    );
    await audit(db, { type: 'system', label: 'auth', ip: meta.ip }, { action: 'auth.login_failed', entityType: 'admin_user', entityId: user.id });
    throw fail;
  }
  await db.query('UPDATE admin_users SET failed_logins = 0, locked_until = NULL WHERE id = $1', [user.id]);
  const token = generateToken(32);
  await db.query(
    `INSERT INTO admin_sessions (id, user_id, mfa_verified, expires_at, ip, user_agent)
     VALUES ($1, $2, FALSE, now() + make_interval(hours => $3), $4, $5)`,
    [sha256(token), user.id, config.sessionTtlHours, meta.ip ?? null, meta.userAgent?.slice(0, 300) ?? null],
  );
  if (!user.mfa_enabled && !config.requireMfa) await markSessionVerified(db, sha256(token), user, meta.ip);
  return { token, mfaRequired: user.mfa_enabled, mfaEnrollmentRequired: !user.mfa_enabled && config.requireMfa };
}

async function markSessionVerified(db: Db, sessionId: string, user: Pick<AdminUser, 'id' | 'name' | 'email'>, ip?: string) {
  await db.query('UPDATE admin_sessions SET mfa_verified = TRUE WHERE id = $1', [sessionId]);
  await db.query('UPDATE admin_users SET last_login_at = now() WHERE id = $1', [user.id]);
  await audit(db, { type: 'admin', id: user.id, label: `${user.name} <${user.email}>`, ip }, { action: 'auth.login', entityType: 'admin_user', entityId: user.id });
}

export async function getSession(db: Db, token: string | undefined): Promise<SessionInfo | null> {
  if (!token || token.length > 100) return null;
  const id = sha256(token);
  const { rows } = await db.query<{ mfa_verified: boolean; id: string; email: string; name: string; role: Role; mfa_enabled: boolean }>(
    `UPDATE admin_sessions s SET last_seen_at = now()
     FROM admin_users u
     WHERE s.id = $1 AND s.user_id = u.id AND s.expires_at > now() AND u.active
     RETURNING s.mfa_verified, u.id, u.email, u.name, u.role, u.mfa_enabled`,
    [id],
  );
  const r = rows[0];
  if (!r) return null;
  return { sessionId: id, mfaVerified: r.mfa_verified, user: { id: r.id, email: r.email, name: r.name, role: r.role, mfa_enabled: r.mfa_enabled } };
}

export async function logout(db: Db, sessionId: string) {
  await db.query('DELETE FROM admin_sessions WHERE id = $1', [sessionId]);
}

async function checkCode(db: Db, user: AdminUser, code: string): Promise<boolean> {
  if (!user.mfa_secret) return false;
  const step = matchTotpStep(decryptSecret(user.mfa_secret), code);
  if (step === null) return false;
  // Reject replay of a code from the same or an earlier time step.
  const { rowCount } = await db.query(
    'UPDATE admin_users SET mfa_last_step = $2 WHERE id = $1 AND (mfa_last_step IS NULL OR mfa_last_step < $2)',
    [user.id, step],
  );
  return rowCount === 1;
}

export async function verifyMfa(db: Db, session: SessionInfo, code: string, ip?: string) {
  const { rows } = await db.query<AdminUser>('SELECT * FROM admin_users WHERE id = $1', [session.user.id]);
  const user = rows[0];
  if (!user.mfa_enabled) throw badRequest('mfa_not_enabled', 'MFA is not set up for this account.');
  if (!(await checkCode(db, user, code))) {
    await audit(db, { type: 'system', label: 'auth', ip }, { action: 'auth.mfa_failed', entityType: 'admin_user', entityId: user.id });
    throw unauthorized('Invalid authentication code.');
  }
  await markSessionVerified(db, session.sessionId, user, ip);
}

export async function beginMfaEnrollment(db: Db, session: SessionInfo) {
  if (session.user.mfa_enabled) throw conflict('mfa_already_enabled', 'MFA is already enabled.');
  const secret = generateSecret();
  await db.query('UPDATE admin_users SET mfa_secret = $2 WHERE id = $1', [session.user.id, encryptSecret(secret)]);
  return { secret, otpauthUrl: otpauthUrl(secret, session.user.email, 'NorbsCoin') };
}

export async function completeMfaEnrollment(db: Db, session: SessionInfo, code: string, ip?: string) {
  const { rows } = await db.query<AdminUser>('SELECT * FROM admin_users WHERE id = $1', [session.user.id]);
  const user = rows[0];
  if (user.mfa_enabled) throw conflict('mfa_already_enabled', 'MFA is already enabled.');
  if (!(await checkCode(db, user, code))) throw unauthorized('Invalid authentication code.');
  await db.query('UPDATE admin_users SET mfa_enabled = TRUE WHERE id = $1', [user.id]);
  await audit(db, actorFor(session, ip), { action: 'auth.mfa_enabled', entityType: 'admin_user', entityId: user.id });
  // End other sessions: they were created before MFA existed.
  await db.query('DELETE FROM admin_sessions WHERE user_id = $1 AND id <> $2', [user.id, session.sessionId]);
  if (!session.mfaVerified) await markSessionVerified(db, session.sessionId, user, ip);
}

export async function listUsers(db: Db) {
  const { rows } = await db.query(
    'SELECT id, email, name, role, mfa_enabled, active, last_login_at, created_at FROM admin_users ORDER BY created_at',
  );
  return rows;
}

export async function updateUser(db: Db, actor: ActorContext, id: string, changes: { role?: Role; active?: boolean; resetMfa?: boolean }) {
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw notFound('User not found');
  const { rows } = await db.query<AdminUser>('SELECT * FROM admin_users WHERE id = $1', [id]);
  const before = rows[0];
  if (!before) throw notFound('User not found');
  if (actor.id === id && (changes.active === false || (changes.role && changes.role !== 'owner')))
    throw badRequest('self_lockout', 'You cannot deactivate or demote yourself.');
  const role = changes.role ?? before.role;
  if (!['owner', 'operator', 'viewer'].includes(role)) throw badRequest('invalid_role', 'Invalid role');
  const active = changes.active ?? before.active;
  await db.query(
    `UPDATE admin_users SET role = $2, active = $3,
       mfa_enabled = CASE WHEN $4 THEN FALSE ELSE mfa_enabled END,
       mfa_secret = CASE WHEN $4 THEN NULL ELSE mfa_secret END
     WHERE id = $1`,
    [id, role, active, !!changes.resetMfa],
  );
  if (!active || changes.resetMfa) await db.query('DELETE FROM admin_sessions WHERE user_id = $1', [id]);
  await audit(db, actor, {
    action: 'user.update',
    entityType: 'admin_user',
    entityId: id,
    before: { role: before.role, active: before.active, mfa_enabled: before.mfa_enabled },
    after: { role, active, mfa_reset: !!changes.resetMfa },
  });
}
