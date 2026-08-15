// Imports fine but does not export a default TaskDefinition — hits loadTasks'
// "must export a default TaskDefinition" error+continue branch.
export const notATask = { foo: 'bar' }
