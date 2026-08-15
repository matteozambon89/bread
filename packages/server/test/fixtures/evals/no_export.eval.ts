// Imports fine but does not export a default EvalDefinition (no `_evalDef`) —
// loadEvals silently skips it (`def?._evalDef` check), no error logged.
export const notAnEval = { foo: 'bar' }
