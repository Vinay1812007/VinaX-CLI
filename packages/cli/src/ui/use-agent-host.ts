import { useMemo, useRef, useState, type RefObject } from 'react';
import {
  updateSettingsFile,
  type AgentHost,
  type PermissionAnswer,
  type PermissionMode,
  type PermissionRequest,
  type PlanDecision,
  type Runtime,
  type UserAnswer,
  type UserQuestion,
} from '@vinax/core';
import { InputQueue } from './input-queue.js';
import { useRefState } from './use-ref-state.js';

/** What the agent is waiting for the user to answer. */
export type Pending = { id: number; since: number } & (
  | { kind: 'permission'; req: PermissionRequest; resolve: (a: PermissionAnswer) => void }
  | { kind: 'plan'; plan: string; resolve: (d: PlanDecision) => void }
  | { kind: 'question'; question: UserQuestion; resolve: (answer: UserAnswer) => void }
);

/**
 * The agent's host for the chat screen: approvals, plans and questions go through one input
 * queue (nested agents included), so only one prompt owns the keyboard at a time.
 */
export function useAgentHost(opts: {
  runtime: Runtime;
  modeRef: RefObject<PermissionMode>;
  setMode: (mode: PermissionMode) => void;
  /** Called after an allow rule was saved to the project's local settings. */
  onRuleSaved: (rule: string, file: string) => void;
  now: () => number;
}): {
  host: AgentHost;
  pending: Pending | undefined;
  pendingRef: RefObject<Pending | undefined>;
  /** Requests waiting behind the one on screen. */
  backlog: number;
} {
  const { runtime, modeRef, setMode, onRuleSaved, now } = opts;
  const [pending, setPending, pendingRef] = useRefState<Pending | undefined>(undefined);
  const [backlog, setBacklog] = useState(0);
  const inputQueue = useMemo(() => new InputQueue(setBacklog), []);
  const nextInputId = useRef(0);
  const hide = (): void => {
    setPending(undefined);
  };

  const host = useMemo<AgentHost>(
    () => ({
      mode: () => modeRef.current,
      askPermission: (req, signal) =>
        inputQueue.request<PermissionAnswer>(
          signal,
          (resolve) => {
            setPending({
              id: nextInputId.current++,
              since: now(),
              kind: 'permission',
              req,
              resolve,
            });
          },
          hide,
          { kind: 'deny', feedback: '' },
        ),
      approvePlan: async (plan, signal) => {
        const decision = await inputQueue.request<PlanDecision>(
          signal,
          (resolve) => {
            setPending({ id: nextInputId.current++, since: now(), kind: 'plan', plan, resolve });
          },
          hide,
          { approved: false, feedback: '' },
        );
        if (decision.approved && !signal.aborted) setMode(decision.mode);
        return decision;
      },
      askQuestion: (question, signal) =>
        inputQueue.request<UserAnswer>(
          signal,
          (resolve) => {
            setPending({
              id: nextInputId.current++,
              since: now(),
              kind: 'question',
              question,
              resolve,
            });
          },
          hide,
          { cancelled: true },
        ),
      saveProjectRule: async (rule) => {
        const file = await updateSettingsFile(
          { cwd: runtime.cwd, env: runtime.env, scope: 'local' },
          (s) => {
            const perms = (s.permissions ?? {}) as { allow?: string[] };
            return {
              ...s,
              permissions: { ...perms, allow: [...new Set([...(perms.allow ?? []), rule])] },
            };
          },
        );
        onRuleSaved(rule, file);
      },
    }),
    [runtime],
  );
  return { host, pending, pendingRef, backlog };
}
