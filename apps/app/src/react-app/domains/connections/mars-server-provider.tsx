/** @jsxImportSource react */
import {
  createContext,
  use,
  useSyncExternalStore,
  type ReactNode,
} from "react";

import type { MarsServerStore } from "./mars-server-store";

const MarsServerContext = createContext<MarsServerStore | null>(null);

export function MarsServerProvider(props: {
  store: MarsServerStore;
  children: ReactNode;
}) {
  return (
    <MarsServerContext.Provider value={props.store}>
      {props.children}
    </MarsServerContext.Provider>
  );
}

export function useMarsServer() {
  const store = use(MarsServerContext);
  if (!store) {
    throw new Error("useMarsServer must be used within an MarsServerProvider");
  }

  useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);

  return store;
}
