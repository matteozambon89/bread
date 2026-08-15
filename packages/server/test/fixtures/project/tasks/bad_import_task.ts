// Throws at module-evaluation time — hits loadTasks' import-failure catch+continue branch.
throw new Error('broken task module')
