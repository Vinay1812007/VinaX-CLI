import { render } from 'ink-testing-library';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_SETTINGS,
  explainError,
  AllModelsFailedError,
  type DoctorCheck,
  type ModelInfo,
  type ProbeResult,
  type ProbeRun,
  type ProviderName,
  type Runtime,
  type SessionSummary,
} from '@vinax/core';
import { FilterSelect, filterItems } from '../../src/ui/components/FilterSelect.js';
import { ErrorCard } from '../../src/ui/components/Messages.js';
import type { SelectItem } from '../../src/ui/components/Select.js';
import { memoryLabels, Welcome } from '../../src/ui/components/Welcome.js';
import { groupChecks, healthMarkdown, healthSummary } from '../../src/health.js';
import {
  modelRows,
  modelSelectItems,
  replacementFor,
  testSummaryNotice,
} from '../../src/ui/model-items.js';
import {
  extendTrail,
  phaseFor,
  toolOutcome,
  turnSummary,
  withDuration,
} from '../../src/ui/phases.js';
import { relativeTime, sessionGroup, sessionItems } from '../../src/ui/sessions.js';
import { resolveTheme, ThemeContext } from '../../src/ui/theme.js';

const mono = resolveTheme('dark', { NO_COLOR: '1' });
const dark = resolveTheme('dark', {});
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let app: ReturnType<typeof render> | undefined;
afterEach(() => {
  app?.unmount();
  app = undefined;
});

/** Foreground colour escapes (`ESC[3xm`, `ESC[9xm`, `ESC[38;…m`); bold alone is fine. */
const hasColour = (text: string): boolean =>
  ['\u001b[3', '\u001b[9'].some((code) => text.includes(code));

function welcome(width: number, theme = mono, env: Record<string, string> = {}) {
  app = render(
    <ThemeContext.Provider value={theme}>
      <Welcome
        version="1.2.3"
        cwd="/work/app"
        model="openai/gpt-oss-20b"
        provider="NVIDIA"
        alias="NVD_CHAT_OSS_20_B"
        branch="main"
        session="new session"
        memory={[
          { path: '/work/app/VINAX.md', scope: 'project', content: '', imports: ['/x/conv.md'] },
          { path: '/work/app/AGENTS.md', scope: 'project', content: '' },
        ]}
        tips={['a tip']}
        width={width}
        env={env}
      />
    </ThemeContext.Provider>,
  );
  return app.lastFrame() ?? '';
}

describe('Welcome', () => {
  it('shows the striped VinaX logo, version, folder, branch, model, alias, session and memory', () => {
    const out = welcome(90);
    // first row of the striped logo: the tops of V, i and X
    expect(out).toContain('▀▀▀     ▀▀▀ ▀▀▀');
    // the chakra sits inside the "a"
    expect(out).toMatch(/▀▀▀ ✺ ▀▀▀/);
    expect(out).toContain('VinaX v1.2.3 · AI coding agent for the terminal');
    expect(out).toContain('/work/app ⎇ main');
    expect(out).toContain('openai/gpt-oss-20b · NVIDIA · NVD_CHAT_OSS_20_B');
    expect(out).toContain('new session');
    expect(out).toContain('✓ VINAX.md');
    expect(out).toContain('✓ AGENTS.md');
    expect(out).toContain('✓ 1 imported file');
    expect(out).toContain('/ commands');
    expect(out).toContain('? shortcuts');
  });

  it('drops the logo and shortcut row in a narrow terminal without overflowing', () => {
    const out = welcome(32);
    expect(out).not.toContain('▀');
    expect(out).toContain('VinaX v1.2.3');
    for (const line of out.split('\n')) expect(line.length).toBeLessThanOrEqual(32);
  });

  it('uses no colour codes under NO_COLOR, and colour otherwise', () => {
    expect(hasColour(welcome(90, mono))).toBe(false);
    app?.unmount();
    // ink-testing-library strips colour unless the environment forces it; the theme still differs
    expect(dark.accent).toBe('#14B8A6');
    expect(mono.accent).toBeUndefined();
  });

  it('falls back to an ASCII mark on dumb terminals', () => {
    const out = welcome(90, mono, { TERM: 'dumb' });
    expect(out).toContain('===     === ===');
    expect(out).not.toContain('▀');
  });

  it('labels memory without paths or content', () => {
    expect(
      memoryLabels(
        [
          { path: '/home/u/.vinax/VINAX.md', scope: 'user', content: 'secret-ish' },
          { path: '/p/src/AGENTS.md', scope: 'nested', content: '' },
        ],
        '/p',
      ),
    ).toEqual(['VINAX.md (personal)', 'src/AGENTS.md']);
  });
});

const items: SelectItem<string>[] = [
  { label: 'openai/gpt-oss-120b', value: 'groq:a', group: 'Groq · groq.com', current: true },
  { label: 'qwen/qwen3', value: 'groq:b', group: 'Groq · groq.com' },
  {
    label: 'openai/gpt-oss-20b',
    value: 'nvidia:openai/gpt-oss-20b',
    group: 'NVIDIA · nvidia.com',
    hint: 'NVD_CHAT_OSS_20_B · 131K ctx',
    keywords: ['NVD_CHAT_OSS_20_B', 'NVIDIA'],
  },
  {
    label: 'meta/llama',
    value: 'nvidia:meta/llama',
    group: 'NVIDIA · nvidia.com',
    disabled: true,
    hint: 'not in catalog',
  },
];

describe('FilterSelect', () => {
  it('matches every word against labels, hints, groups and keywords', () => {
    expect(filterItems(items, 'nvd_').map((i) => i.value)).toEqual(['nvidia:openai/gpt-oss-20b']);
    // a provider name finds all of its models
    expect(filterItems(items, 'nvidia')).toHaveLength(2);
    expect(filterItems(items, 'nvidia oss').map((i) => i.value)).toEqual([
      'nvidia:openai/gpt-oss-20b',
    ]);
    expect(filterItems(items, '')).toHaveLength(4);
    expect(filterItems(items, 'zzz')).toEqual([]);
  });

  it('groups items, marks the current one, filters as you type and picks with Enter', async () => {
    const onSelect = vi.fn();
    app = render(
      <ThemeContext.Provider value={mono}>
        <FilterSelect items={items} onSelect={onSelect} width={80} />
      </ThemeContext.Provider>,
    );
    const frame = () => app?.lastFrame() ?? '';
    expect(frame()).toContain('Groq · groq.com');
    expect(frame()).toContain('NVIDIA · nvidia.com');
    expect(frame()).toContain('❯ ● openai/gpt-oss-120b');
    await sleep(30);
    app.stdin.write('nvd_');
    await sleep(30);
    expect(frame()).toContain('⌕ nvd_ · 1 of 4');
    expect(frame()).not.toContain('Groq · groq.com');
    app.stdin.write('\r');
    await sleep(30);
    expect(onSelect).toHaveBeenCalledWith('nvidia:openai/gpt-oss-20b');
  });

  it('skips disabled items when moving', async () => {
    const onSelect = vi.fn();
    app = render(
      <ThemeContext.Provider value={mono}>
        <FilterSelect items={items} onSelect={onSelect} width={80} />
      </ThemeContext.Provider>,
    );
    await sleep(30);
    app.stdin.write('\x1b[A'); // up from the first wraps to the last choosable item
    await sleep(30);
    app.stdin.write('\r');
    await sleep(30);
    expect(onSelect).toHaveBeenCalledWith('nvidia:openai/gpt-oss-20b');
  });
});

function fakeRuntime(opts: {
  providers: ProviderName[];
  models?: Partial<Record<ProviderName, ModelInfo[]>>;
  skipped?: string[];
  viaGateway?: ProviderName[];
  freeModelsOnly?: boolean;
  probes?: Partial<Record<ProviderName, ProbeResult[]>>;
}): Runtime {
  return {
    providers: new Map(opts.providers.map((p) => [p, {}])),
    models: new Map(Object.entries(opts.models ?? {})),
    probes: new Map(
      Object.entries(opts.probes ?? {}).map(([p, list]) => [
        p,
        new Map(list.map((r) => [r.model, r])),
      ]),
    ),
    skipped: new Set(opts.skipped ?? []),
    viaGateway: new Set(opts.viaGateway ?? []),
    settings: {
      resolved: { ...DEFAULT_SETTINGS, freeModelsOnly: opts.freeModelsOnly ?? true },
    },
  } as unknown as Runtime;
}

const info = (id: string, contextWindow?: number): ModelInfo => ({
  id,
  contextWindow,
  supportsTools: undefined,
  free: true,
});

describe('model picker items', () => {
  it('lists configured providers first, with NVIDIA aliases and context', () => {
    const runtime = fakeRuntime({
      providers: ['nvidia', 'groq'],
      models: {
        groq: [info('openai/gpt-oss-120b', 131_072), info('tiny', 2048)],
        nvidia: [info('openai/gpt-oss-20b', 131_072), info('nvidia/embed-v1')],
      },
    });
    const list = modelSelectItems(runtime, 'nvidia:openai/gpt-oss-20b');
    expect(
      list
        .slice(0, 2)
        .map((i) => [i.group, i.label, i.hint, i.current === true, i.disabled === true]),
    ).toEqual([
      ['Groq · groq.com', 'openai/gpt-oss-120b', 'free · 131K ctx', false, false],
      [
        'NVIDIA · nvidia.com',
        'openai/gpt-oss-20b',
        'NVD_CHAT_OSS_20_B · free · 131K ctx',
        true,
        false,
      ],
    ]);
    expect(list.some((i) => i.value === 'gemini:gemini-2.5-flash')).toBe(true);
  });

  it('shows known models of unconfigured providers as unavailable', () => {
    const runtime = fakeRuntime({ providers: ['groq'], models: { groq: [info('m', 32_000)] } });
    const nvidia = modelSelectItems(runtime, 'groq:m').find((i) => i.value.startsWith('nvidia:'));
    expect(nvidia).toMatchObject({
      label: 'openai/gpt-oss-20b',
      disabled: true,
      hint: 'NVD_CHAT_OSS_20_B · 131K ctx · no key · /login',
      group: 'NVIDIA · nvidia.com · not configured',
    });
  });

  it('marks skipped models and keeps a custom current model', () => {
    const runtime = fakeRuntime({
      providers: ['nvidia'],
      models: { nvidia: [info('other/model', 8192)] },
      skipped: ['nvidia:openai/gpt-oss-20b'],
      viaGateway: ['nvidia'],
    });
    const rows = modelRows(runtime, 'nvidia:custom/one');
    expect(rows.slice(0, 3).map((r) => [r.ref, r.status])).toEqual([
      ['nvidia:custom/one', 'unlisted'],
      ['nvidia:openai/gpt-oss-20b', 'unlisted'],
      ['nvidia:other/model', 'ready'],
    ]);
    // Claude bills every request, so it is left out while freeModelsOnly is on.
    expect(rows.some((r) => r.ref === 'claude:claude-sonnet-4-5')).toBe(false);
    expect(modelSelectItems(runtime, 'nvidia:other/model')[0]?.group).toBe(
      'NVIDIA · nvidia.com · via VinaX gateway',
    );
  });

  it('hides paid models by default and lists them again when asked', () => {
    const opts = {
      providers: ['nvidia' as ProviderName],
      models: { nvidia: [info('other/model', 8192)] },
    };
    const paidRef = 'claude:claude-sonnet-4-5';
    const free = modelRows(fakeRuntime(opts), 'nvidia:other/model');
    expect(free.some((r) => r.ref === paidRef)).toBe(false);
    expect(free.every((r) => r.free || r.current)).toBe(true);

    const all = modelRows(fakeRuntime({ ...opts, freeModelsOnly: false }), 'nvidia:other/model');
    expect(all.some((r) => r.ref === paidRef)).toBe(true);
  });

  it('keeps a paid model listed while it is the one in use', () => {
    const rows = modelRows(
      fakeRuntime({
        providers: ['nvidia'],
        models: { nvidia: [info('other/model', 8192)] },
      }),
      'claude:claude-sonnet-4-5',
    );
    expect(rows.find((r) => r.ref === 'claude:claude-sonnet-4-5')?.current).toBe(true);
  });

  it('falls back to the full list rather than showing nothing usable', () => {
    // Only a paid API has a key, so filtering to free would leave no selectable model at all.
    const rows = modelRows(
      fakeRuntime({ providers: ['claude'], models: { claude: [info('claude-sonnet-4-5')] } }),
      'claude:claude-sonnet-4-5',
    );
    expect(rows.some((r) => r.provider === 'claude' && r.status === 'ready')).toBe(true);
  });
});

const passed = (model: string): ProbeResult => ({ model, ok: true, at: Date.now(), ms: 10 });
const failed = (model: string, reason = 'no answer within 20s'): ProbeResult => ({
  model,
  ok: false,
  at: Date.now(),
  kind: 'timeout',
  reason,
});

describe('model lists after a model test', () => {
  const nvidiaModels = [
    info('openai/gpt-oss-20b', 131_072),
    info('meta/llama-3.1-8b-instruct', 131_072),
    info('retired/dead-model', 32_000),
    info('busy/model', 32_000),
  ];

  it('lists only the models that answered, and keeps the current one marked when it did not', () => {
    const runtime = fakeRuntime({
      providers: ['nvidia'],
      models: { nvidia: nvidiaModels },
      probes: {
        nvidia: [
          failed('openai/gpt-oss-20b'),
          passed('meta/llama-3.1-8b-instruct'),
          failed('retired/dead-model', 'HTTP 404'),
          {
            model: 'busy/model',
            ok: false,
            at: Date.now(),
            kind: 'rate_limit',
            reason: 'rate limited',
          },
        ],
      },
    });
    const items = modelSelectItems(runtime, 'nvidia:openai/gpt-oss-20b').filter((i) =>
      i.value.startsWith('nvidia:'),
    );
    // known models first, then the catalog's order; the 404 is gone
    expect(items.map((i) => i.value)).toEqual([
      'nvidia:openai/gpt-oss-20b',
      'nvidia:busy/model',
      'nvidia:meta/llama-3.1-8b-instruct',
    ]);
    expect(items[0]).toMatchObject({
      current: true,
      hint: 'NVD_CHAT_OSS_20_B · free · 131K ctx · did not answer the last test (no answer within 20s)',
    });
    expect(items[0]?.disabled).toBeFalsy();
    expect(items[1]?.hint).toContain('rate limited during the last test');
  });

  it('drops a failed model that is not in use, and lists everything when nothing was tested', () => {
    const tested = fakeRuntime({
      providers: ['nvidia'],
      models: { nvidia: nvidiaModels },
      probes: { nvidia: [failed('openai/gpt-oss-20b'), passed('meta/llama-3.1-8b-instruct')] },
    });
    expect(
      modelRows(tested, 'groq:x')
        .filter((r) => r.provider === 'nvidia')
        .map((r) => r.model),
    ).toEqual(['meta/llama-3.1-8b-instruct']);
    const untested = fakeRuntime({ providers: ['nvidia'], models: { nvidia: nvidiaModels } });
    expect(modelRows(untested, 'groq:x').filter((r) => r.provider === 'nvidia')).toHaveLength(4);
  });

  it('lists paid models only when they are allowed and answered', () => {
    const paid: ModelInfo = {
      ...info('paid/model', 32_000),
      free: false,
      pricing: { prompt: 1e-6, completion: 1e-6 },
    };
    const probes = { openrouter: [passed('paid/model'), passed('free/model:free')] };
    const models = { openrouter: [paid, info('free/model:free', 32_000)] };
    const freeOnly = modelRows(
      fakeRuntime({ providers: ['openrouter'], models, probes }),
      'openrouter:free/model:free',
    );
    expect(freeOnly.map((r) => r.model)).not.toContain('paid/model');
    const all = modelRows(
      fakeRuntime({ providers: ['openrouter'], models, probes, freeModelsOnly: false }),
      'openrouter:free/model:free',
    );
    expect(all.map((r) => r.model)).toContain('paid/model');
    const notTested = modelRows(
      fakeRuntime({
        providers: ['openrouter'],
        models,
        probes: { openrouter: [passed('free/model:free')] },
        freeModelsOnly: false,
      }),
      'openrouter:free/model:free',
    );
    expect(notTested.map((r) => r.model)).not.toContain('paid/model');
  });

  it('summarizes a test and suggests a model that answered', () => {
    const run: ProbeRun = {
      provider: 'nvidia',
      candidates: ['openai/gpt-oss-20b', 'meta/llama-3.1-8b-instruct', 'x/y'],
      results: [failed('openai/gpt-oss-20b'), passed('meta/llama-3.1-8b-instruct'), failed('x/y')],
      tested: 3,
      ok: 1,
      keyRejected: false,
      unreachable: false,
    };
    expect(testSummaryNotice(run, true)).toEqual({
      level: 'info',
      text: '1 of 3 free NVIDIA models answered.',
    });
    expect(replacementFor(run, 'NVD_CHAT_OSS_20_B')).toBe('nvidia:meta/llama-3.1-8b-instruct');
    expect(replacementFor(run, 'nvidia:meta/llama-3.1-8b-instruct')).toBeUndefined();
    expect(replacementFor(run, 'groq:other')).toBeUndefined();
    expect(testSummaryNotice({ ...run, keyRejected: true }, true)?.level).toBe('error');
    expect(testSummaryNotice({ ...run, unreachable: true }, true)?.text).toContain(
      'Could not reach NVIDIA',
    );
  });
});

describe('providers a gateway does not serve', () => {
  it('explains that the gateway lacks the provider instead of "not in catalog"', () => {
    const runtime = fakeRuntime({
      providers: ['groq', 'nvidia'],
      models: { groq: [info('openai/gpt-oss-120b', 131_072)], nvidia: [] },
      skipped: ['nvidia:openai/gpt-oss-20b'],
      viaGateway: ['groq', 'nvidia'],
    });
    const nvidia = modelSelectItems(runtime, 'groq:openai/gpt-oss-120b').find((i) =>
      i.value.startsWith('nvidia:'),
    );
    expect(nvidia).toMatchObject({
      disabled: true,
      hint: 'NVD_CHAT_OSS_20_B · 131K ctx · add your own key with /login',
      group: 'NVIDIA · nvidia.com · not served by your VinaX gateway',
    });
  });
});

describe('agent progress', () => {
  it('maps tools to phases and keeps a short trail', () => {
    expect(phaseFor('Grep', 'foo')).toBe('Inspecting repository');
    expect(phaseFor('TodoWrite', '')).toBe('Planning');
    expect(phaseFor('Edit', 'src/a.ts')).toBe('Editing');
    expect(phaseFor('Bash', 'pnpm test')).toBe('Running tests');
    expect(phaseFor('Bash', 'ls -la')).toBe('Running commands');
    expect(phaseFor('Task', 'explore')).toBe('Delegating to a sub-agent');
    expect(extendTrail(['Inspecting repository'], 'Inspecting repository')).toEqual([
      'Inspecting repository',
    ]);
    expect(extendTrail(['Inspecting repository'], 'Editing')).toEqual([
      'Inspecting repository',
      'Editing',
    ]);
  });

  it('summarizes a turn and tells denials from tool errors', () => {
    expect(
      turnSummary(
        [
          { name: 'Read', label: 'a.ts', ok: true },
          { name: 'Edit', label: 'a.ts', ok: true },
          { name: 'Edit', label: 'a.ts', ok: true },
          { name: 'Write', label: 'b.ts', ok: true },
          { name: 'Bash', label: 'rm -rf x', ok: false },
        ],
        3200,
      ),
    ).toBe('Updated 2 files · 5 tool calls · 1 not completed · 3.2s');
    expect(turnSummary([{ name: 'Read', label: 'a', ok: true }], 65_000)).toBe(
      'No files changed · 1 tool call · 1m 05s',
    );
    expect(toolOutcome(false, 'Denied')).toBe('blocked');
    expect(toolOutcome(false, 'Declined')).toBe('blocked');
    expect(toolOutcome(false, 'File not found')).toBe('error');
    expect(toolOutcome(true, 'x')).toBe('ok');
    expect(withDuration('184 lines', 2500)).toBe('184 lines · 2.5s');
    expect(withDuration('exit 0 · 3 lines · 3.2s', 3300)).toBe('exit 0 · 3 lines · 3.2s');
    expect(withDuration('184 lines', 200)).toBe('184 lines');
  });
});

describe('sessions', () => {
  const now = new Date(2026, 8, 29, 15, 0, 0);
  const at = (days: number, hours = 0) =>
    new Date(now.getTime() - days * 86_400_000 - hours * 3_600_000);
  const summary = (id: string, updatedAt: Date, extra: Partial<SessionSummary> = {}) =>
    ({
      id,
      title: undefined,
      firstPrompt: `prompt ${id}`,
      model: undefined,
      createdAt: updatedAt.toISOString(),
      updatedAt,
      turns: 2,
      file: `${id}.jsonl`,
      ...extra,
    }) as SessionSummary;

  it('groups by day and describes age', () => {
    expect(sessionGroup(at(0, 2), now)).toBe('Today');
    expect(sessionGroup(at(1), now)).toBe('Yesterday');
    expect(sessionGroup(at(4), now)).toBe('This week');
    expect(sessionGroup(at(40), now)).toBe('Older');
    expect(relativeTime(at(0, 3), now)).toBe('3h ago');
    expect(relativeTime(new Date(now.getTime() - 30_000), now)).toBe('just now');
  });

  it('builds picker items, newest first, with titles, age, prompts and model', () => {
    const list = sessionItems(
      [
        summary('old', at(10)),
        summary('new', at(0, 1), { title: 'Add NVIDIA model', model: 'nvidia:openai/gpt-oss-20b' }),
      ],
      now,
    );
    expect(list.map((i) => [i.group, i.label, i.hint])).toEqual([
      ['Today', 'Add NVIDIA model', '1h ago · 2 prompts · nvidia:openai/gpt-oss-20b'],
      ['Older', 'prompt old', '10d ago · 2 prompts'],
    ]);
  });
});

describe('health summary', () => {
  const checks: DoctorCheck[] = [
    { name: 'Node.js', status: 'ok', detail: 'v22', group: 'runtime' },
    { name: 'NVIDIA key', status: 'skip', detail: 'not set', group: 'providers' },
    { name: 'Groq key', status: 'fail', detail: 'rejected', group: 'providers' },
    { name: 'MCP', status: 'warn', detail: 'x failed', group: 'integrations' },
  ];

  it('counts and groups checks', () => {
    expect(healthSummary(checks)).toBe('1 ok · 1 warning · 1 failure · 1 not set up');
    expect(groupChecks(checks).map((g) => g.label)).toEqual([
      'Runtime',
      'Providers & models',
      'Integrations',
    ]);
    const md = healthMarkdown(checks);
    expect(md).toContain('- ○ **NVIDIA key** — not set');
    expect(md).toContain('- ✖ **Groq key** — rejected');
  });
});

describe('ErrorCard', () => {
  it('shows provider, model, category, reason and actions', () => {
    const report = explainError(
      new AllModelsFailedError([
        {
          ref: { provider: 'nvidia', model: 'openai/gpt-oss-20b' },
          reason: 'NVIDIA 401: Invalid API Key',
          kind: 'auth',
        },
      ]),
    );
    app = render(
      <ThemeContext.Provider value={mono}>
        <ErrorCard report={report} width={100} />
      </ThemeContext.Provider>,
    );
    const out = app.lastFrame() ?? '';
    expect(out).toContain('✖ Provider request failed');
    expect(out).toContain('NVIDIA · openai/gpt-oss-20b — authentication failed');
    expect(out).toContain('HTTP 401: Invalid API Key');
    expect(out).toContain('› check the NVIDIA key');
    expect(out).toContain('› run /health');
  });
});
