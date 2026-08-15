// Throws at module-evaluation time — hits loadEvals' import-failure catch+continue branch.
throw new Error('broken eval module')
