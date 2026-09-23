import { Box, Text, useInput } from 'ink';
import { useEffect, useState, type ReactNode } from 'react';
import {
  PROVIDER_NAMES,
  providerLabel,
  SECRET_ENV_VARS,
  THEME_NAMES,
  type GatewayCheck,
  type KeyCheck,
  type ModelInfo,
  type ProviderName,
  type ThemeName,
} from '@vinax/core';
import { formatTokens } from '../format.js';
import { renderMarkdown } from '../markdown.js';
import { THEME_LABELS, THEMES, useTheme } from '../theme.js';
import { LineInput } from './LineInput.js';
import { Select } from './Select.js';

export interface OnboardingDeps {
  envKey: (p: ProviderName) => string | undefined;
  storedKey: (p: ProviderName) => Promise<string | undefined>;
  validateKey: (p: ProviderName, key: string) => Promise<KeyCheck>;
  saveKey: (p: ProviderName, key: string) => Promise<void>;
  listModels: (p: ProviderName, key: string) => Promise<ModelInfo[]>;
  saveSettings: (patch: { theme: ThemeName; model?: string }) => Promise<void>;
  /** Checks a gateway and token, waking the gateway first (`onWaking` fires if it was asleep). */
  checkGateway: (url: string, token: string, onWaking: () => void) => Promise<GatewayCheck>;
  saveGateway: (url: string, token: string) => Promise<void>;
  defaultModel: string;
}

interface Props {
  deps: OnboardingDeps;
  initialTheme: ThemeName;
  colorDisabled: boolean;
  onThemePreview: (name: ThemeName) => void;
  onDone: () => void;
}

type Step = 'theme' | 'provider' | 'key' | 'gateway' | 'model' | 'done';
const STEPS: readonly Step[] = ['theme', 'provider', 'key', 'model'];

type KeyState =
  | { phase: 'checking'; source: string }
  | { phase: 'entry'; error?: string }
  | { phase: 'validating' }
  | { phase: 'ok'; message: string; warning?: boolean };

type GatewayState =
  | { phase: 'url'; error?: string }
  | { phase: 'token'; url: string; error?: string }
  | { phase: 'checking'; url: string; waking: boolean }
  | { phase: 'ok'; url: string; message: string; warning?: boolean };

const PREVIEW = [
  '## Preview',
  'Some **bold** text, a `code span` and a [link](https://example.com).',
  '```ts',
  'const answer: number = 42; // the answer',
  '```',
].join('\n');

/** Chat-capable models: enough context, tool support not ruled out, and free on OpenRouter. */
export function chatModels(models: readonly ModelInfo[], provider: ProviderName): ModelInfo[] {
  return models
    .filter((m) => (m.contextWindow ?? 0) >= 8192 && m.supportsTools !== false)
    .filter((m) => provider !== 'openrouter' || m.free)
    .sort((a, b) => a.id.localeCompare(b.id));
}

function Frame({ step, children }: { step: Step; children: ReactNode }) {
  const theme = useTheme();
  const n = STEPS.indexOf(step === 'gateway' ? 'key' : step) + 1;
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={theme.accent} paddingX={1}>
      <Text>
        <Text bold color={theme.accent}>
          Welcome to VinaX
        </Text>
        {step === 'done' ? null : (
          <Text color={theme.muted}>
            {' '}
            · setup {n}/{STEPS.length}
          </Text>
        )}
      </Text>
      <Box marginTop={1} flexDirection="column">
        {children}
      </Box>
    </Box>
  );
}

export function Onboarding({ deps, initialTheme, colorDisabled, onThemePreview, onDone }: Props) {
  const theme = useTheme();
  const [step, setStep] = useState<Step>('theme');
  const [themeName, setThemeName] = useState<ThemeName>(initialTheme);
  const [providers, setProviders] = useState<ProviderName[]>([]);
  const [keyIndex, setKeyIndex] = useState(0);
  const [keyState, setKeyState] = useState<KeyState>({ phase: 'entry' });
  const [keys, setKeys] = useState<Partial<Record<ProviderName, string>>>({});
  const [models, setModels] = useState<
    { provider: ProviderName; list: ModelInfo[] } | 'loading' | 'none'
  >('loading');
  const [model, setModel] = useState<string | undefined>(undefined);
  const [saving, setSaving] = useState(false);
  const [gateway, setGateway] = useState<GatewayState>({ phase: 'url' });
  const gatewayUrl = gateway.phase === 'ok' ? gateway.url : undefined;

  const current = providers[keyIndex];

  // When a provider's key step starts, try an existing key (env var or stored) first.
  useEffect(() => {
    if (step !== 'key' || current === undefined) return;
    const run = { cancelled: false };
    void (async () => {
      const fromEnv = deps.envKey(current);
      const existing = fromEnv ?? (await deps.storedKey(current));
      if (existing === undefined) {
        if (!run.cancelled) setKeyState({ phase: 'entry' });
        return;
      }
      const source = fromEnv === undefined ? 'your saved key' : SECRET_ENV_VARS[current];
      setKeyState({ phase: 'checking', source });
      const check = await deps.validateKey(current, existing);
      if (run.cancelled) return;
      if (check.ok) {
        setKeys((k) => ({ ...k, [current]: existing }));
        setKeyState({
          phase: 'ok',
          message: `Using ${source} — ${providerLabel(current)} accepted it.`,
        });
      } else if (check.rejected) {
        setKeyState({
          phase: 'entry',
          error: `${providerLabel(current)} rejected ${source}. Enter a new key.`,
        });
      } else {
        setKeys((k) => ({ ...k, [current]: existing }));
        setKeyState({
          phase: 'ok',
          warning: true,
          message: `Using ${source}, but it could not be checked: ${check.reason}`,
        });
      }
    })();
    return () => {
      run.cancelled = true;
    };
  }, [step, current, deps]);

  // Load the model list for the first provider that has a working key.
  useEffect(() => {
    if (step !== 'model') return;
    const provider = PROVIDER_NAMES.find((p) => providers.includes(p) && keys[p] !== undefined);
    const key = provider === undefined ? undefined : keys[provider];
    if (provider === undefined || key === undefined) {
      setModels('none');
      return;
    }
    let cancelled = false;
    setModels('loading');
    deps
      .listModels(provider, key)
      .then((list) => {
        if (!cancelled) setModels({ provider, list: chatModels(list, provider) });
      })
      .catch(() => {
        if (!cancelled) setModels('none');
      });
    return () => {
      cancelled = true;
    };
  }, [step, providers, keys, deps]);

  const nextKey = (): void => {
    if (keyIndex + 1 < providers.length) {
      setKeyIndex(keyIndex + 1);
      setKeyState({ phase: 'entry' });
    } else {
      setStep('model');
    }
  };

  const submitKey = async (value: string): Promise<void> => {
    if (current === undefined) return;
    setKeyState({ phase: 'validating' });
    const check = await deps.validateKey(current, value);
    if (!check.ok && check.rejected) {
      setKeyState({
        phase: 'entry',
        error: `${providerLabel(current)} rejected that key. Check it and try again.`,
      });
      return;
    }
    await deps.saveKey(current, value);
    setKeys((k) => ({ ...k, [current]: value }));
    setKeyState(
      check.ok
        ? { phase: 'ok', message: `Key saved — ${providerLabel(current)} accepted it.` }
        : {
            phase: 'ok',
            warning: true,
            message: `Key saved, but it could not be checked: ${check.reason}`,
          },
    );
  };

  const submitGateway = async (url: string, token: string): Promise<void> => {
    setGateway({ phase: 'checking', url, waking: false });
    const check = await deps.checkGateway(url, token, () => {
      setGateway({ phase: 'checking', url, waking: true });
    });
    if (!check.ok && check.rejected) {
      const toUrl = /URL|https/.test(check.reason);
      setGateway(
        toUrl
          ? { phase: 'url', error: check.reason }
          : { phase: 'token', url, error: check.reason },
      );
      return;
    }
    await deps.saveGateway(url, token);
    setGateway(
      check.ok
        ? {
            phase: 'ok',
            url,
            message: `Connected${check.version === undefined ? '' : ` to gateway v${check.version}`} — ${String(check.models)} models available.`,
          }
        : {
            phase: 'ok',
            url,
            warning: true,
            message: `Saved, but it could not be checked: ${check.reason}`,
          },
    );
  };

  const finish = async (): Promise<void> => {
    setSaving(true);
    await deps.saveSettings({ theme: themeName, ...(model === undefined ? {} : { model }) });
    onDone();
  };

  const noModels = models === 'none' || (models !== 'loading' && models.list.length === 0);
  useInput(
    (_input, key) => {
      if (!key.return) return;
      if (step === 'key' && keyState.phase === 'ok') nextKey();
      else if (step === 'gateway' && gateway.phase === 'ok') setStep('done');
      else if (step === 'done' && !saving) void finish();
      else if (step === 'model' && noModels) setStep('done');
    },
    {
      isActive:
        step === 'done' ||
        (step === 'key' && keyState.phase === 'ok') ||
        (step === 'gateway' && gateway.phase === 'ok') ||
        (step === 'model' && noModels),
    },
  );

  if (step === 'theme') {
    return (
      <Frame step={step}>
        <Text bold>Choose a colour theme</Text>
        {colorDisabled ? (
          <Text color={theme.muted}>NO_COLOR is set, so VinaX will not use colours anyway.</Text>
        ) : null}
        <Box marginY={1}>
          <Select
            items={THEME_NAMES.map((name) => ({ label: THEME_LABELS[name], value: name }))}
            initialIndex={THEME_NAMES.indexOf(initialTheme)}
            onHighlight={(name) => {
              setThemeName(name);
              onThemePreview(name);
            }}
            onSelect={(name) => {
              setThemeName(name);
              onThemePreview(name);
              setStep('provider');
            }}
          />
        </Box>
        <Text>
          {renderMarkdown(PREVIEW, { width: 60, theme: colorDisabled ? theme : THEMES[themeName] })}
        </Text>
      </Frame>
    );
  }

  if (step === 'provider') {
    return (
      <Frame step={step}>
        <Text bold>Which provider do you want to use?</Text>
        <Text color={theme.muted}>
          Both are free. You can add the other one later with `vinax config set-key`.
        </Text>
        <Box marginTop={1}>
          <Select<ProviderName[] | 'gateway'>
            items={[
              { label: 'Groq', value: ['groq'], hint: 'fastest · ~8K tokens/min per model' },
              {
                label: 'OpenRouter',
                value: ['openrouter'],
                hint: 'many :free models · 50 requests/day',
              },
              {
                label: 'Both',
                value: ['groq', 'openrouter'],
                hint: 'recommended: Groq first, OpenRouter as fallback',
              },
              {
                label: 'A VinaX gateway',
                value: 'gateway',
                hint: 'no keys needed: someone runs a shared gateway for you',
              },
            ]}
            initialIndex={2}
            onSelect={(list) => {
              if (list === 'gateway') {
                setGateway({ phase: 'url' });
                setStep('gateway');
                return;
              }
              setProviders(list);
              setKeyIndex(0);
              setKeyState({ phase: 'entry' });
              setStep('key');
            }}
          />
        </Box>
      </Frame>
    );
  }

  if (step === 'key' && current !== undefined) {
    const url = current === 'groq' ? 'https://console.groq.com/keys' : 'https://openrouter.ai/keys';
    return (
      <Frame step={step}>
        <Text bold>{providerLabel(current)} API key</Text>
        <Text color={theme.muted}>
          Get one at {url}. It is stored in your OS keychain (or a private file).
        </Text>
        <Box marginTop={1} flexDirection="column">
          {keyState.phase === 'checking' ? (
            <Text color={theme.muted}>Checking {keyState.source}…</Text>
          ) : null}
          {keyState.phase === 'validating' ? (
            <Text color={theme.muted}>Checking the key with {providerLabel(current)}…</Text>
          ) : null}
          {keyState.phase === 'entry' ? (
            <>
              {keyState.error === undefined ? null : (
                <Text color={theme.error}>✖ {keyState.error}</Text>
              )}
              <LineInput
                mask
                placeholder={`Paste your ${providerLabel(current)} key and press Enter (Esc to skip)`}
                onSubmit={(v) => void submitKey(v)}
                onCancel={nextKey}
              />
            </>
          ) : null}
          {keyState.phase === 'ok' ? (
            <>
              <Text color={keyState.warning === true ? theme.warning : theme.success}>
                {keyState.warning === true ? '⚠' : '✔'} {keyState.message}
              </Text>
              <Text color={theme.muted}>Press Enter to continue</Text>
            </>
          ) : null}
        </Box>
      </Frame>
    );
  }

  if (step === 'gateway') {
    return (
      <Frame step={step}>
        <Text bold>Connect to a VinaX gateway</Text>
        <Text color={theme.muted}>
          The person who runs it gives you its URL and a token. Requests then use their shared keys.
        </Text>
        <Box marginTop={1} flexDirection="column">
          {gateway.phase === 'url' ? (
            <>
              {gateway.error === undefined ? null : (
                <Text color={theme.error}>✖ {gateway.error}</Text>
              )}
              <LineInput
                placeholder="Gateway URL, e.g. https://vinax-gateway.onrender.com (Esc to go back)"
                onSubmit={(v) => {
                  const url = v.trim().replace(/\/+$/, '');
                  if (url !== '') setGateway({ phase: 'token', url });
                }}
                onCancel={() => {
                  setStep('provider');
                }}
              />
            </>
          ) : null}
          {gateway.phase === 'token' ? (
            <>
              <Text color={theme.muted}>{gateway.url}</Text>
              {gateway.error === undefined ? null : (
                <Text color={theme.error}>✖ {gateway.error}</Text>
              )}
              <LineInput
                mask
                placeholder="Paste your gateway token and press Enter (Esc to change the URL)"
                onSubmit={(v) => void submitGateway(gateway.url, v.trim())}
                onCancel={() => {
                  setGateway({ phase: 'url' });
                }}
              />
            </>
          ) : null}
          {gateway.phase === 'checking' ? (
            <Text color={theme.muted}>
              {gateway.waking
                ? 'Waking VinaX gateway… free servers sleep when idle; this can take a minute'
                : `Checking ${gateway.url}…`}
            </Text>
          ) : null}
          {gateway.phase === 'ok' ? (
            <>
              <Text color={gateway.warning === true ? theme.warning : theme.success}>
                {gateway.warning === true ? '⚠' : '✔'} {gateway.message}
              </Text>
              <Text color={theme.muted}>Press Enter to continue</Text>
            </>
          ) : null}
        </Box>
      </Frame>
    );
  }

  if (step === 'model') {
    if (models === 'loading') {
      return (
        <Frame step={step}>
          <Text color={theme.muted}>Loading the model list…</Text>
        </Frame>
      );
    }
    if (models === 'none' || noModels) {
      return (
        <Frame step={step}>
          <Text>
            The model list is not available right now, so VinaX will use {deps.defaultModel}.
          </Text>
          <Text color={theme.muted}>Press Enter to continue</Text>
        </Frame>
      );
    }
    const refs = models.list.map((m) => `${models.provider}:${m.id}`);
    return (
      <Frame step={step}>
        <Text bold>Pick your default model</Text>
        <Text color={theme.muted}>
          Fallback models are tried automatically when this one is rate-limited.
        </Text>
        <Box marginTop={1}>
          <Select
            items={models.list.map((m, i) => ({
              label: m.id,
              value: refs[i] ?? m.id,
              ...(m.contextWindow === undefined
                ? {}
                : { hint: `${formatTokens(m.contextWindow)} context` }),
            }))}
            initialIndex={Math.max(0, refs.indexOf(deps.defaultModel))}
            onSelect={(ref) => {
              setModel(ref);
              setStep('done');
            }}
          />
        </Box>
      </Frame>
    );
  }

  const configured = PROVIDER_NAMES.filter((p) => keys[p] !== undefined);
  return (
    <Frame step="done">
      <Text bold color={theme.success}>
        You&apos;re all set.
      </Text>
      <Text>
        <Text color={theme.muted}>theme </Text>
        {THEME_LABELS[themeName]}
      </Text>
      {gatewayUrl === undefined ? (
        <Text>
          <Text color={theme.muted}>keys </Text>
          {configured.length === 0 ? 'none yet' : configured.map(providerLabel).join(', ')}
        </Text>
      ) : (
        <Text>
          <Text color={theme.muted}>gateway </Text>
          {gatewayUrl}
        </Text>
      )}
      <Text>
        <Text color={theme.muted}>model </Text>
        {model ?? deps.defaultModel}
      </Text>
      {configured.length === 0 && gatewayUrl === undefined ? (
        <Text color={theme.warning}>
          ⚠ Without a key VinaX cannot answer. Add one later: vinax config set-key groq
        </Text>
      ) : null}
      <Box marginTop={1}>
        <Text color={theme.muted}>{saving ? 'Saving…' : 'Press Enter to start'}</Text>
      </Box>
    </Frame>
  );
}
