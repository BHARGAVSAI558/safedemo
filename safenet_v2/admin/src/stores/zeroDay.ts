import { create } from 'zustand';

export type ZeroDayRow = {
  id: number;
  zone_id: string;
  offline_ratio: number;
  confidence: number;
  offline_count?: number;
  total_count?: number;
  status?: string;
  message?: string;
  created_at?: string;
  timestamp?: number;
};

type State = {
  items: ZeroDayRow[];
  upsert: (row: ZeroDayRow) => void;
  setAll: (rows: ZeroDayRow[]) => void;
};

export const useZeroDayStore = create<State>((set, get) => ({
  items: [],
  upsert: (row) => {
    const cur = get().items.filter((x) => x.id !== row.id);
    set({ items: [row, ...cur].slice(0, 100) });
  },
  setAll: (rows) => set({ items: rows }),
}));
