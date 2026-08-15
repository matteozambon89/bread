// Throws at module-evaluation time — the dynamic `import()` in loadTools must
// reject, hitting the tool import-failure catch+continue branch.
throw new Error('broken tool module')
