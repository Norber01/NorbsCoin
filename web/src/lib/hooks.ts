import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import type { PublicConfig } from './types';

export function useAsync<T>(fn: () => Promise<T>, deps: unknown[]) {
  const [state, setState] = useState<{ data?: T; error?: Error; loading: boolean }>({ loading: true });
  const fnRef = useRef(fn);
  fnRef.current = fn;
  const run = useCallback(() => {
    setState((s) => ({ ...s, loading: true, error: undefined }));
    return fnRef.current().then(
      (data) => setState({ data, loading: false }),
      (error: Error) => setState({ error, loading: false }),
    );
  }, []);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => void run(), deps);
  return { ...state, reload: run, setData: (data: T) => setState({ data, loading: false }) };
}

export function useNow(intervalMs = 1000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return now;
}

export const ConfigContext = createContext<PublicConfig | null>(null);
export const useConfig = () => useContext(ConfigContext);
