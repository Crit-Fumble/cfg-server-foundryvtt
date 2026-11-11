/**
 * forbiddenCode: a 403 body with a rights code means the credential is alive.
 */

describe('forbiddenCode', () => {
  it('recognizes exactly the rights codes, on a JSON object body only', async () => {
    const { forbiddenCode, FORBIDDEN_CODES } = await import('../../scripts/auth/forbidden-codes.js')
    expect(FORBIDDEN_CODES).toEqual(['SCOPE_REQUIRED', 'INSTALLATION_OWNER_REQUIRED', 'NOT_GM'])
    expect(forbiddenCode({ code: 'SCOPE_REQUIRED' })).toBe('SCOPE_REQUIRED')
    expect(forbiddenCode({ code: 'INSTALLATION_OWNER_REQUIRED' })).toBe('INSTALLATION_OWNER_REQUIRED')
    // The body courier-auth.ts:146 actually sends — bare 'Forbidden' text, the
    // code carrying the whole signal. Without NOT_GM here a non-GM courier tick
    // reads as a DEAD credential, on the eleven sync routes polled on a timer.
    expect(forbiddenCode({ error: 'Forbidden', code: 'NOT_GM' })).toBe('NOT_GM')
    expect(forbiddenCode({ code: 'FORBIDDEN' })).toBeNull()
    expect(forbiddenCode({ error: 'no code at all' })).toBeNull()
    expect(forbiddenCode('SCOPE_REQUIRED')).toBeNull()
    expect(forbiddenCode(null)).toBeNull()
  })
})
