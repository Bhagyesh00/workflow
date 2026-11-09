/**
 * P5-67 (L2): `/assistant` and `/assistant/:threadId`: thread list, thread, artifacts. An owner or admin with no
 * model gets `AssistantWizard` (L8); others get the no-model text.
 *
 * The URL names the open thread: opening `/assistant/:threadId` loads it (messages, status, then the stream);
 * the first message of a new chat makes a thread, and the URL follows it. Every role can chat. Leaving the page
 * ends the stream and empties the store.
 */
import { useQuery } from '@tanstack/react-query';
import { Sparkles } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { errorMessage } from '../api/client';
import { settingsApi } from '../api/endpoints';
import { assistantFeatureOf, queryKeys, useMe } from '../api/queries';
import { ArtifactsPanel } from '../components/assistant/ArtifactsPanel';
import { AssistantComposer } from '../components/assistant/AssistantComposer';
import { AssistantThreadList } from '../components/assistant/AssistantThreadList';
import { ASSISTANT_EMPTY_TEXT, AssistantThreadView } from '../components/assistant/AssistantThreadView';
import { AssistantWizard } from '../components/assistant/AssistantWizard';
import { Callout, EmptyState, PageLoader } from '../components/ui/misc';
import { canWith } from '../lib/permissions';
import {
  createAssistantThread,
  deleteAssistantThread,
  refreshAssistantThreads,
  renameAssistantThread,
  useAssistantStore,
} from '../stores/assistant-store';
import { toast } from '../stores/ui-store';

/** what everyone but an owner or admin reads while no model is set */
export const ASSISTANT_NO_MODEL_TEXT = 'No model is set. An admin can set one in Settings';
/** the composer's reason while a card waits */
export const ASSISTANT_CARD_WAITING = 'Answer the request above first';

function AssistantOff({ canManage }: { canManage: boolean }) {
  return (
    <EmptyState
      icon={<Sparkles size={22} />}
      title="The Assistant is off"
      description={
        canManage ? (
          <>
            Turn it on in{' '}
            <Link to="/settings/assistant" className="font-semibold text-brand hover:underline">
              Settings
            </Link>
            .
          </>
        ) : (
          'An admin can turn it on in Settings.'
        )
      }
    />
  );
}

function AssistantWorkspace() {
  const { threadId: param } = useParams();
  const routeThreadId = param ?? null;
  const navigate = useNavigate();
  const threads = useAssistantStore((s) => s.threads);
  const activeThreadId = useAssistantStore((s) => s.activeThreadId);
  const status = useAssistantStore((s) => s.status);
  const pending = useAssistantStore((s) => s.pending);
  const artifacts = useAssistantStore((s) => s.artifacts);
  const [listError, setListError] = useState<string | null>(null);
  const [listLoading, setListLoading] = useState(true);

  // the thread list, once per visit; leaving the page ends the stream
  useEffect(() => {
    let live = true;
    refreshAssistantThreads()
      .then(() => live && setListError(null))
      .catch((error: unknown) => live && setListError(errorMessage(error)))
      .finally(() => live && setListLoading(false));
    return () => {
      live = false;
      useAssistantStore.getState().reset();
    };
  }, []);

  // the URL opens a thread
  useEffect(() => {
    if (useAssistantStore.getState().activeThreadId !== routeThreadId) {
      void useAssistantStore.getState().openThread(routeThreadId);
    }
  }, [routeThreadId]);

  // a thread the store opened itself (the first message of a new chat) moves the URL
  // biome-ignore lint/correctness/useExhaustiveDependencies: only a change of the open thread moves the URL
  useEffect(() => {
    if (activeThreadId && activeThreadId !== routeThreadId) {
      navigate(`/assistant/${encodeURIComponent(activeThreadId)}`, { replace: routeThreadId === null });
    }
  }, [activeThreadId]);

  const create = async () => {
    try {
      const thread = await createAssistantThread();
      navigate(`/assistant/${encodeURIComponent(thread.id)}`);
    } catch (error) {
      toast.error("Couldn't start a chat", errorMessage(error));
    }
  };

  const rename = async (threadId: string, title: string) => {
    try {
      await renameAssistantThread(threadId, title);
    } catch (error) {
      toast.error("Couldn't rename the chat", errorMessage(error));
    }
  };

  const remove = async (threadId: string) => {
    try {
      await deleteAssistantThread(threadId);
      if (routeThreadId === threadId) navigate('/assistant', { replace: true });
    } catch (error) {
      toast.error("Couldn't delete the chat", errorMessage(error));
    }
  };

  const title = threads.find((thread) => thread.id === activeThreadId)?.title;
  const disabledReason = pending.length > 0 ? ASSISTANT_CARD_WAITING : null;

  return (
    <div className="flex h-full min-h-0 flex-col md:flex-row">
      <aside className="flex max-h-56 shrink-0 flex-col gap-2 border-b border-line p-3 md:max-h-none md:w-64 md:border-r md:border-b-0">
        {listLoading && !threads.length ? (
          <PageLoader label="Loading chats" />
        ) : (
          <AssistantThreadList
            threads={threads}
            activeThreadId={activeThreadId}
            onSelect={(id) => navigate(`/assistant/${encodeURIComponent(id)}`)}
            onCreate={() => void create()}
            onRename={(id, next) => void rename(id, next)}
            onDelete={(id) => void remove(id)}
          />
        )}
        {listError && <Callout tone="err">{`Couldn't load your chats. ${listError}`}</Callout>}
      </aside>

      <section className="flex min-h-0 min-w-0 flex-1 flex-col" aria-label="Chat">
        <header className="flex items-center gap-2 border-b border-line px-4 py-3">
          <Sparkles size={18} className="text-brand" aria-hidden />
          <div className="min-w-0">
            <h1 className="text-md font-semibold">Assistant</h1>
            {title && <p className="truncate text-xs text-ink-2">{title}</p>}
          </div>
        </header>
        {activeThreadId ? (
          <AssistantThreadView threadId={activeThreadId} />
        ) : routeThreadId ? (
          <PageLoader label="Loading the chat" />
        ) : (
          <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 px-6 py-14 text-center">
            <Sparkles size={22} className="text-brand" aria-hidden />
            <p className="font-display text-md font-semibold">{ASSISTANT_EMPTY_TEXT}</p>
            <p className="max-w-80 text-sm text-ink-2">
              The Assistant reads your workspace and asks before it changes anything.
            </p>
          </div>
        )}
        <div className="border-t border-line px-4 py-3">
          <div className="mx-auto max-w-3xl">
            <AssistantComposer
              running={status === 'running'}
              disabledReason={status === 'loading' ? 'Loading the chat' : disabledReason}
              onSend={(body) => useAssistantStore.getState().send(body)}
              onStop={() => void useAssistantStore.getState().stop()}
            />
          </div>
        </div>
      </section>

      <aside className="hidden w-72 shrink-0 flex-col border-l border-line p-3 lg:flex">
        <ArtifactsPanel artifacts={artifacts} />
      </aside>
    </div>
  );
}

export function AssistantPage() {
  const me = useMe();
  const settings = useQuery({
    queryKey: queryKeys.settings,
    queryFn: settingsApi.get,
    retry: false,
    staleTime: 5 * 60_000,
  });
  if (me.isPending || settings.isPending) return <PageLoader label="Loading the Assistant" />;
  if (settings.isError) {
    return (
      <div className="mx-auto max-w-xl px-6 py-10">
        <Callout tone="err">{`Couldn't load the Assistant. ${errorMessage(settings.error)}`}</Callout>
      </div>
    );
  }
  const canManage = canWith(me.data, 'instanceAi:manage');
  const feature = assistantFeatureOf(settings.data);
  if (!feature.enabled) return <AssistantOff canManage={canManage} />;
  if (!feature.modelSet) {
    return canManage ? (
      <section className="mx-auto max-w-3xl px-6 py-8" aria-label="Set up the Assistant">
        <AssistantWizard />
      </section>
    ) : (
      <EmptyState icon={<Sparkles size={22} />} title={ASSISTANT_NO_MODEL_TEXT} />
    );
  }
  return <AssistantWorkspace />;
}
