/**
 * Game-system document schema descriptors (dt#212) — the in-Foundry JSON editor's local half.
 *
 * Covers:
 *   - describeModel reads `schema.fields`, and falls back to a callable defineSchema()
 *   - required means "required with no default" — not merely `required: true`
 *   - descriptorForDocumentClass returns null for classes it cannot describe
 *   - a model that throws on introspection is skipped, never fatal
 */

import { jest } from '@jest/globals'

async function loadSync() {
  jest.resetModules()
  return await import('../../scripts/sync/system-schema-sync.js')
}

/** A DataField as Foundry shapes one. */
const field = (props = {}) => ({ required: false, nullable: false, initial: undefined, ...props })

/** A model whose schema is a SchemaField wrapping a field map. */
const model = (fields) => ({ schema: { fields } })

beforeEach(() => {
  jest.clearAllMocks()
  game.user = { isGM: true, id: 'test-gm-id' }
  game.system = { id: 'dnd5e', version: '5.3.3' }
  globalThis.CONFIG = {}
})

describe('describeModel', () => {
  it('reads the field map off schema.fields', async () => {
    const { describeModel } = await loadSync()
    expect(describeModel(model({ a: field(), b: field() }))).toEqual({ fields: ['a', 'b'] })
  })

  it('falls back to a callable defineSchema()', async () => {
    const { describeModel } = await loadSync()
    expect(describeModel({ defineSchema: () => ({ x: field() }) })).toEqual({ fields: ['x'] })
  })

  it('treats required-with-an-initial as NOT required of the GM', async () => {
    // Most Foundry fields are required AND carry an initial — the model fills them in, so erroring
    // on them would put a red underline under every well-formed document.
    const { describeModel } = await loadSync()
    const out = describeModel(model({ hp: field({ required: true, initial: 10 }) }))
    expect(out).toEqual({ fields: ['hp'] })
  })

  it('reports required-with-no-default, the case that actually breaks a document', async () => {
    const { describeModel } = await loadSync()
    const out = describeModel(
      model({
        classIdentifier: field({ required: true }),
        description: field({ required: true, initial: '' }),
      }),
    )
    // `description` has an empty-string default, so it lands in requiredNonEmpty — a different
    // finding from "absent", and reported separately.
    expect(out).toEqual({
      fields: ['classIdentifier', 'description'],
      required: ['classIdentifier'],
      requiredNonEmpty: ['description'],
    })
  })

  it('reads the default from getInitialValue(), not the `initial` property', async () => {
    // Every dnd5e 5.3.3 subclass field looks like this: required, not nullable, `initial`
    // undefined — yet each returns a real default from getInitialValue(). Testing `initial`
    // marks all six required and errors on every well-formed subclass.
    const { describeModel } = await loadSync()
    const dnd5eShaped = (initial) => ({ required: true, nullable: false, initial: undefined, getInitialValue: () => initial })
    const out = describeModel(
      model({
        classIdentifier: dnd5eShaped(''),
        description: dnd5eShaped({ value: '', chat: '' }),
        source: dnd5eShaped({ revision: 1, rules: '2024' }),
      }),
    )
    expect(out.fields).toEqual(['classIdentifier', 'description', 'source'])
    expect(out.required).toBeUndefined()
    // classIdentifier's default is the empty string, so it is still reported — just as
    // "set this", not as "this is missing".
    expect(out.requiredNonEmpty).toEqual(['classIdentifier'])
  })

  it('flags a required field whose default is an EMPTY STRING', async () => {
    // The live case: dnd5e defaults classIdentifier to "", so a converted subclass attaches to no
    // class while looking perfectly well-formed.
    const { describeModel } = await loadSync()
    const dnd5eShaped = (initial) => ({ required: true, nullable: false, initial: undefined, getInitialValue: () => initial })
    const out = describeModel(
      model({
        classIdentifier: dnd5eShaped(''),
        identifier: dnd5eShaped(''),
        description: dnd5eShaped({ value: '', chat: '' }),
        advancement: dnd5eShaped({}),
      }),
    )
    expect(out.requiredNonEmpty).toEqual(['classIdentifier', 'identifier'])
    // An empty OBJECT default is a normal resting state — flagging it would bury the real finding.
    expect(out.requiredNonEmpty).not.toContain('description')
    expect(out.requiredNonEmpty).not.toContain('advancement')
  })

  it('omits requiredNonEmpty when nothing qualifies', async () => {
    const { describeModel } = await loadSync()
    const out = describeModel(model({ a: { required: true, nullable: false, getInitialValue: () => 'preset' } }))
    expect(out.requiredNonEmpty).toBeUndefined()
  })

  it('still reports a field whose getInitialValue() yields nothing', async () => {
    const { describeModel } = await loadSync()
    const out = describeModel(
      model({
        mustSupply: { required: true, nullable: false, initial: undefined, getInitialValue: () => undefined },
        hasDefault: { required: true, nullable: false, initial: undefined, getInitialValue: () => '' },
      }),
    )
    expect(out).toEqual({
      fields: ['mustSupply', 'hasDefault'],
      required: ['mustSupply'],
      requiredNonEmpty: ['hasDefault'],
    })
  })

  it('does not claim required when the initial-value machinery throws', async () => {
    const { describeModel } = await loadSync()
    const out = describeModel(model({ odd: { required: true, nullable: false, getInitialValue: () => { throw new Error('boom') } } }))
    expect(out).toEqual({ fields: ['odd'] })
  })

  it('does not call a nullable field required — null is its own default', async () => {
    const { describeModel } = await loadSync()
    expect(describeModel(model({ img: field({ required: true, nullable: true }) }))).toEqual({ fields: ['img'] })
  })

  it.each([
    ['null', null],
    ['a model with no schema', {}],
    ['a schema that throws', { get schema() { throw new Error('boom') } }],
  ])('returns null for %s rather than guessing', async (_label, input) => {
    const { describeModel } = await loadSync()
    expect(describeModel(input)).toBeNull()
  })
})

describe('descriptorForDocumentClass', () => {
  it('builds one descriptor for a single class from live CONFIG', async () => {
    globalThis.CONFIG = { Item: { dataModels: { subclass: model({ classIdentifier: field({ required: true }) }) } } }
    const { descriptorForDocumentClass } = await loadSync()
    const d = descriptorForDocumentClass('Item')
    expect(d).toEqual({
      systemId: 'dnd5e',
      systemVersion: '5.3.3',
      documentClass: 'Item',
      types: { subclass: { fields: ['classIdentifier'], required: ['classIdentifier'] } },
    })
  })

  it('returns null for a class the system does not describe', async () => {
    globalThis.CONFIG = { Item: { dataModels: { feat: model({ a: field() }) } } }
    const { descriptorForDocumentClass } = await loadSync()
    expect(descriptorForDocumentClass('Actor')).toBeNull()
  })

  it('returns null when there is no system', async () => {
    globalThis.game.system = undefined
    globalThis.CONFIG = { Item: { dataModels: { feat: model({ a: field() }) } } }
    const { descriptorForDocumentClass } = await loadSync()
    expect(descriptorForDocumentClass('Item')).toBeNull()
  })

  it('returns null for a class whose every model failed to introspect', async () => {
    // An empty types map would read as "this system declares no types", which is a different and
    // wrong claim.
    globalThis.CONFIG = { Item: { dataModels: { broken: null } } }
    const { descriptorForDocumentClass } = await loadSync()
    expect(descriptorForDocumentClass('Item')).toBeNull()
  })

  it('omits systemVersion when Foundry does not report one', async () => {
    globalThis.game.system = { id: 'cyphersystem' }
    globalThis.CONFIG = { Item: { dataModels: { skill: model({ a: field() }) } } }
    const { descriptorForDocumentClass } = await loadSync()
    expect(descriptorForDocumentClass('Item').systemVersion).toBeUndefined()
  })
})
