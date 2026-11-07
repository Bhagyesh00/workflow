import type { ChatEventHandler, ChatEventMap, ChatEventName, ChatEvents } from './index';

/** The widget's event bus: five events, handlers removed with the returned function or `off`. */
export function createEvents(): ChatEvents {
  const handlers = new Map<ChatEventName, Set<ChatEventHandler<ChatEventName>>>();

  function off<K extends ChatEventName>(event: K, handler: ChatEventHandler<K>): void {
    handlers.get(event)?.delete(handler as ChatEventHandler<ChatEventName>);
  }

  return {
    on(event, handler) {
      let set = handlers.get(event);
      if (!set) {
        set = new Set();
        handlers.set(event, set);
      }
      set.add(handler as ChatEventHandler<ChatEventName>);
      return () => off(event, handler);
    },
    off,
    emit(event, ...payload) {
      const set = handlers.get(event);
      if (!set) return;
      // copy: a handler may remove itself
      for (const handler of [...set]) {
        try {
          handler(payload[0] as ChatEventMap[ChatEventName]);
        } catch {
          // one failing handler must not stop the others
        }
      }
    },
  };
}
