import type { ProviderRegistry } from './model-provider.js'
import type { EvalCase, EvalConfig, EvalDefinition, EvalScorer } from './types.js'

export interface EvalResult {
  name: string
  passed: boolean
  score: number
  details?: string | undefined
}

export interface EvalSuiteResult {
  agentId: string
  type: string
  total: number
  passed: number
  failed: number
  results: EvalResult[]
}

// ---------------------------------------------------------------------------
// Scorers
// ---------------------------------------------------------------------------

async function scoreOutput(
  output: unknown,
  scorer: EvalScorer,
  providers?: ProviderRegistry,
): Promise<EvalResult> {
  const text = typeof output === 'string' ? output : JSON.stringify(output)

  switch (scorer.type) {
    case 'exact':
      return { name: 'exact', passed: text === scorer.expected, score: text === scorer.expected ? 1 : 0 }

    case 'contains':
      return {
        name: 'contains',
        passed: text.includes(scorer.expected),
        score: text.includes(scorer.expected) ? 1 : 0,
      }

    case 'regex': {
      const re = new RegExp(scorer.pattern)
      const passed = re.test(text)
      return { name: 'regex', passed, score: passed ? 1 : 0 }
    }

    case 'llmJudge': {
      const model = process.env['BREAD_EVAL_MODEL'] ?? scorer.model ?? 'openai/gpt-4o-mini'
      const { resolveModel } = await import('./model-provider.js')
      const [provider, modelName] = model.split('/')
      const lm = await resolveModel({ provider: provider!, model: modelName! }, [providers])
      const { generateText } = await import('ai')
      const result = await generateText({
        model: lm,
        prompt: `${scorer.prompt}\n\nOutput to evaluate:\n${text}\n\nRespond with only "PASS" or "FAIL".`,
      })
      const passed = result.text.trim().toUpperCase() === 'PASS'
      return { name: 'llmJudge', passed, score: passed ? 1 : 0, details: result.text }
    }

    case 'custom': {
      const passed = await scorer.fn(output)
      return { name: 'custom', passed: Boolean(passed), score: passed ? 1 : 0 }
    }
  }
}

// ---------------------------------------------------------------------------
// Eval runner
// ---------------------------------------------------------------------------

export async function runEvals(
  evalDef: EvalDefinition,
  runFn: (agentId: string, input: unknown, skill?: string) => Promise<unknown>,
  providers?: ProviderRegistry,
): Promise<EvalSuiteResult> {
  const cfg: EvalConfig = evalDef.config
  const results: EvalResult[] = []

  for (const evalCase of cfg.cases) {
    let output: unknown
    try {
      output = await runFn(cfg.agentId, evalCase.input, evalCase.skill)
    } catch (err) {
      results.push({
        name: evalCase.name,
        passed: false,
        score: 0,
        details: `Error: ${err instanceof Error ? err.message : String(err)}`,
      })
      continue
    }

    let totalScore = 0
    const scorerResults: EvalResult[] = []
    for (const scorer of evalCase.scorers) {
      const r = await scoreOutput(output, scorer, providers)
      scorerResults.push(r)
      totalScore += r.score
    }

    const score = evalCase.scorers.length > 0 ? totalScore / evalCase.scorers.length : 1
    const passed = score >= 1
    results.push({
      name: evalCase.name,
      passed,
      score,
      details: scorerResults.map((r) => `${r.name}: ${r.passed ? 'PASS' : 'FAIL'}`).join(', '),
    })
  }

  const passed = results.filter((r) => r.passed).length
  return {
    agentId: cfg.agentId,
    type: cfg.type ?? 'functional',
    total: results.length,
    passed,
    failed: results.length - passed,
    results,
  }
}
