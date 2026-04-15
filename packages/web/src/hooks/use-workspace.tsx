import {
  createContext,
  useContext,
  useState,
  useEffect,
  useCallback,
  type ReactNode,
} from "react";
import {
  workspaces as wsApi,
  type Workspace,
} from "../lib/api-client.js";
import { useAuth } from "./use-auth.js";

interface WorkspaceState {
  workspaceList: Workspace[];
  current: Workspace | null;
  loading: boolean;
  select: (ws: Workspace) => void;
  refresh: () => Promise<void>;
}

const WorkspaceContext = createContext<WorkspaceState | null>(null);

const STORAGE_KEY = "nexnote_workspace_id";

export function WorkspaceProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const [workspaceList, setWorkspaceList] = useState<Workspace[]>([]);
  const [current, setCurrent] = useState<Workspace | null>(null);
  const [loading, setLoading] = useState(true);

  const userId = user?.id;

  const refresh = useCallback(async () => {
    if (!userId) return;
    setLoading(true);
    try {
      const res = await wsApi.list({ limit: 100 });
      setWorkspaceList(res.data);

      const savedId = localStorage.getItem(STORAGE_KEY);
      const saved = res.data.find((w) => w.id === savedId);
      if (saved) {
        setCurrent(saved);
      } else if (res.data.length > 0) {
        setCurrent(res.data[0]);
        localStorage.setItem(STORAGE_KEY, res.data[0].id);
      }
    } finally {
      setLoading(false);
    }
  }, [userId]);

  useEffect(() => {
    if (userId) {
      refresh();
    } else {
      setWorkspaceList([]);
      setCurrent(null);
      setLoading(false);
    }
  }, [userId, refresh]);

  const select = useCallback((ws: Workspace) => {
    setCurrent(ws);
    localStorage.setItem(STORAGE_KEY, ws.id);
  }, []);

  return (
    <WorkspaceContext.Provider
      value={{ workspaceList, current, loading, select, refresh }}
    >
      {children}
    </WorkspaceContext.Provider>
  );
}

export function useWorkspace() {
  const ctx = useContext(WorkspaceContext);
  if (!ctx) {
    throw new Error("useWorkspace must be used within a WorkspaceProvider");
  }
  return ctx;
}
